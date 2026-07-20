import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "image-route-test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, overrides: { apiKey?: string | null } = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey ?? "test-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

async function seedCodexConnection(accessToken: string, priority: number) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: `codex-${priority}`,
    email: `codex-${priority}@example.com`,
    priority,
    accessToken,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { workspaceId: `workspace-${priority}` },
  });
}

function codexImageSuccessResponse(imageBase64 = "Y29kZXgtaW1hZ2U=") {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        result: imageBase64,
        revised_prompt: "A refined image prompt",
      },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("v1 image models GET exposes image-only modalities for image-only models", async () => {
  const response = await imageRoute.GET();
  const body = (await response.json()) as any;
  const byId = new Map(body.data.map((item: { id: string }) => [item.id, item]));

  assert.equal(response.status, 200);
  assert.deepEqual((byId.get("topaz/topaz-enhance") as any).input_modalities, ["image"]);
  assert.deepEqual((byId.get("stability-ai/remove-background") as any).input_modalities, ["image"]);
  assert.deepEqual((byId.get("stability-ai/fast") as any).input_modalities, ["image"]);
});

test("v1 image generation route allows a 360s server window", () => {
  assert.equal(imageRoute.maxDuration, 360);
});

test("v1 image generation POST accepts promptless requests for image-only models", async () => {
  await seedConnection("topaz", { apiKey: "topaz-key" });

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl === "https://example.com/topaz-input.png") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (stringUrl === "https://api.topazlabs.com/image/v1/enhance") {
      const formData = options.body as FormData;
      assert.ok(formData.get("image") instanceof File);
      return new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "topaz/topaz-enhance",
        image_url: "https://example.com/topaz-input.png",
        size: "2048x2048",
        response_format: "b64_json",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "BwcH");
});

test("v1 image generation POST still requires prompts for text-input models", async () => {
  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        image_url: "https://example.com/source.png",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.match(body.error.message, /Prompt is required for image model: openai\/gpt-image-2/);
});

test("v1 image edit POST enforces disabled API key policy", async () => {
  const createdKey = await apiKeysDb.createApiKey("Disabled image edit key", "machine-image-edit");
  await apiKeysDb.updateApiKeyPermissions(createdKey.id, { isActive: false });

  const formData = new FormData();
  formData.set("prompt", "make the background lighter");
  formData.set("model", "cgpt-web/gpt-5.3-instant");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${createdKey.key}` },
      body: formData,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/);
});

test("v1 image generation POST resolves proxy and executes with proxy context when credentials.connectionId exists", async () => {
  // Create a connection — it gets an auto-generated id used as credentials.connectionId
  const connection = await seedConnection("openai", { apiKey: "image-proxy-key" });

  // Set a key-level proxy for this specific connection (id = connectionId)
  await settingsDb.setProxyForLevel("key", (connection as any).id, {
    type: "http",
    host: "127.0.0.1",
    port: 1, // intentionally unreachable — proves proxy path was taken
  });

  globalThis.fetch = async () => {
    throw new Error("fetch should not be called — proxy fast-fail should trigger first");
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy test image",
      }),
    })
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as any;
  assert.match(body.error.message, /unreachable/i);
  assert.equal(body.error.message_vi, "Dịch vụ AI tạm thời không khả dụng. Vui lòng thử lại sau.");
});

test("v1 image generation POST executes directly when proxy resolution fails gracefully", async () => {
  const connection = await seedConnection("openai", { apiKey: "image-proxy-fail-key" });

  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'keys', 'corrupt-json')"
  ).run();

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "https://api.openai.com/v1/images/generations") {
      return new Response(
        JSON.stringify({ created: 123, data: [{ url: "https://cdn.example.com/proxy-fail.png" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "proxy failover image",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.equal(body.data[0].url, "https://cdn.example.com/proxy-fail.png");
});

test("v1 image generation POST executes directly when credentials.connectionId is absent (authType: none)", async () => {
  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === "http://localhost:7860/sdapi/v1/txt2img") {
      return new Response(JSON.stringify({ images: ["YmFzZTY0LWltYWdl"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sdwebui/stable-diffusion-v1-5",
        prompt: "no credentials test",
      }),
    })
  );

  const body = (await response.json()) as any;
  assert.equal(response.status, 200);
  assert.ok(body.data, "should have image data");
});

test("v1 Codex image generation rotates to the next account after usage_limit_reached", async () => {
  const exhausted = await seedCodexConnection("codex-exhausted-token", 1);
  await seedCodexConnection("codex-healthy-token", 2);
  let attempts = 0;

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
    attempts += 1;
    const authorization = new Headers(options.headers).get("authorization");
    if (authorization === "Bearer codex-exhausted-token") {
      return new Response(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "plus",
            resets_at: Math.floor(Date.now() / 1000) + 488_892,
            eligible_promo: null,
            resets_in_seconds: 488_892,
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      );
    }
    assert.equal(authorization, "Bearer codex-healthy-token");
    return codexImageSuccessResponse();
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-5.5",
        prompt: "A polished product photograph",
        response_format: "b64_json",
      }),
    })
  );
  const body = (await response.json()) as any;
  const exhaustedAfter = await providersDb.getProviderConnectionById((exhausted as any).id);

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(body.data[0].b64_json, "Y29kZXgtaW1hZ2U=");
  assert.equal((exhaustedAfter as any).testStatus, "unavailable");
  const scopeReset = (exhaustedAfter as any).providerSpecificData.codexScopeRateLimitedUntil.codex;
  assert.ok(new Date(scopeReset).getTime() - Date.now() > 488_000_000);
});

test("v1 Codex image generation returns a localized 429 with the real reset window when all accounts are exhausted", async () => {
  await seedCodexConnection("codex-only-exhausted-token", 1);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: Math.floor(Date.now() / 1000) + 488_892,
          eligible_promo: null,
          resets_in_seconds: 488_892,
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } }
    );

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-5.5",
        prompt: "A polished product photograph",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 488_000);
  assert.match(body.error.message, /All Codex accounts.*Plus usage limit/i);
  assert.match(body.error.message_vi, /hạn mức Plus/i);
});
