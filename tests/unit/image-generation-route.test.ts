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
const imageControl = await import("../../src/lib/db/imageGenerationEvents.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const providerImageRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");

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

async function createManagedImageKey() {
  return apiKeysDb.createApiKey(
    `Image user ${Math.random().toString(16).slice(2, 8)}`,
    "image-route-test-machine"
  );
}

function jsonRequestWithKey(
  apiKey: { key: string },
  body: Record<string, unknown>,
  url = "http://localhost/api/v1/images/generations"
) {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function authorizedJsonRequest(
  body: Record<string, unknown>,
  url = "http://localhost/api/v1/images/generations"
) {
  return jsonRequestWithKey(await createManagedImageKey(), body, url);
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

test("v1 image generation rejects requests without a managed API key", async () => {
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "anonymous image request",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.message, "Authentication required");
  assert.equal(providerCalled, false);
});

test("v1 image generation rejects invalid API keys", async () => {
  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-image-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "invalid key image request",
      }),
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.message, "Invalid API key");
});

test("v1 provider-specific image generation also requires a managed API key", async () => {
  const response = await providerImageRoute.POST(
    new Request("http://localhost/api/v1/providers/openai/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "provider alias request" }),
    }),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.message, "Authentication required");
});

test("v1 image edit also requires a managed API key", async () => {
  const formData = new FormData();
  formData.set("prompt", "edit the image");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      body: formData,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.message, "Authentication required");
});

test("v1 image edit rejects oversized multipart requests before parsing", async () => {
  const apiKey = await createManagedImageKey();
  const formData = new FormData();
  formData.set("prompt", "oversized edit");
  formData.set("image", new File([new Uint8Array([1])], "source.png", { type: "image/png" }));

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.key}`,
        "content-length": String(25 * 1024 * 1024),
      },
      body: formData,
    })
  );

  assert.equal(response.status, 413);
});

test("v1 image edit rejects chunked bodies above the total request cap", async () => {
  const apiKey = await createManagedImageKey();
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(22 * 1024 * 1024 + 1));
      controller.close();
    },
  });

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.key}`,
        "content-type": "multipart/form-data; boundary=image-edit-test",
      },
      body: oversizedBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
  );
  const body = (await response.json()) as { error: { message: string } };

  assert.equal(response.status, 413);
  assert.equal(body.error.message, "Image edit request is too large");
});

test("v1 provider-specific image generation uses the managed control plane", async () => {
  await seedConnection("openai", { apiKey: "provider-route-key" });
  const apiKey = await createManagedImageKey();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: "cHJvdmlkZXItcm91dGU=" }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "provider-upstream-1" },
    });

  const response = await providerImageRoute.POST(
    jsonRequestWithKey(
      apiKey,
      { model: "gpt-image-2", prompt: "provider control request" },
      "http://localhost/api/v1/providers/openai/images/generations"
    ),
    { params: Promise.resolve({ provider: "openai" }) }
  );
  const requestId = response.headers.get("x-request-id");
  const event = requestId ? imageControl.getImageGenerationEventByRequestId(requestId) : null;

  assert.equal(response.status, 200);
  assert.ok(requestId);
  assert.equal(event?.apiKeyId, apiKey.id);
  assert.equal(event?.provider, "openai");
  assert.equal(event?.status, "succeeded");
  assert.equal(event?.upstreamRequestId, "provider-upstream-1");
});

test("v1 image edit enforces per-key image policy before provider access", async () => {
  const apiKey = await createManagedImageKey();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { imageGenerationEnabled: false });
  const formData = new FormData();
  formData.set("prompt", "blocked edit");
  formData.set("model", "cgpt-web/gpt-5.3-instant");
  formData.set("image", new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" }));
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageEditRoute.POST(
    new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.key}` },
      body: formData,
    })
  );
  const body = (await response.json()) as any;
  const requestId = response.headers.get("x-request-id");
  const event = requestId ? imageControl.getImageGenerationEventByRequestId(requestId) : null;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/i);
  assert.equal(providerCalled, false);
  assert.equal(event?.operation, "edit");
  assert.equal(event?.status, "rejected");
});

test("v1 image generation rejects n greater than one", async () => {
  await seedConnection("openai");
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "amplified request",
      n: 2,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.equal(body.error.message, "Invalid request");
  assert.equal(providerCalled, false);
});

test("v1 image generation rejects unsupported sizes", async () => {
  await seedConnection("openai");
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "oversized request",
      size: "3840x2160",
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.equal(body.error.message, "Invalid request");
  assert.equal(providerCalled, false);
});

test("v1 image generation rejects unknown request fields", async () => {
  await seedConnection("openai");
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "unknown field request",
      unrestricted_provider_option: true,
    })
  );

  assert.equal(response.status, 400);
  assert.equal(providerCalled, false);
});

test("v1 image generation rejects timeout values above 180 seconds", async () => {
  await seedConnection("openai");
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "slow request",
      timeout_ms: 180_001,
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 400);
  assert.equal(body.error.message, "Invalid request");
  assert.equal(providerCalled, false);
});

test("v1 image generation accepts the documented transparent background option", async () => {
  await seedConnection("openai", { apiKey: "transparent-background-key" });
  let upstreamBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: [{ b64_json: "dHJhbnNwYXJlbnQ=" }] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-1.5",
      prompt: "transparent product icon",
      background: "transparent",
      output_format: "png",
      image_url: "data:image/png;base64,aW1hZ2UtaW5wdXQ=",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBody?.background, "transparent");
  assert.equal(upstreamBody?.output_format, "png");
  assert.equal(upstreamBody?.image_url, "data:image/png;base64,aW1hZ2UtaW5wdXQ=");
});

test("v1 image generation applies conservative quality and size defaults", async () => {
  await seedConnection("openai", { apiKey: "default-policy-provider-key" });
  let upstreamBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ data: [{ b64_json: "ZGVmYXVsdA==" }] });
  };

  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "default policy request",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamBody?.quality, "medium");
  assert.equal(upstreamBody?.size, "1024x1024");
  assert.equal(upstreamBody?.n, 1);
});

test("v1 image generation restricts provider selection to the key's allowed connections", async () => {
  await seedConnection("openai", { apiKey: "blocked-image-connection" });
  const allowedConnection = await seedConnection("openai", { apiKey: "allowed-image-connection" });
  const apiKey = await createManagedImageKey();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedConnections: [(allowedConnection as { id: string }).id],
  });

  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") || "";
    return Response.json({ data: [{ b64_json: "YWxsb3dlZA==" }] });
  };

  const response = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-1.5",
      prompt: "allowed connection only",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(authorization, "Bearer allowed-image-connection");
});

test("v1 image generation attributes successful requests to the managed API key", async () => {
  await seedConnection("openai", { apiKey: "audit-provider-key" });
  const apiKey = await createManagedImageKey();

  let upstreamRequest: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    upstreamRequest = init;
    return new Response(
      JSON.stringify({ created: 123, data: [{ b64_json: "YXVkaXQtaW1hZ2U=" }] }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "upstream-image-request-1",
        },
      }
    );
  };

  const response = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "private audit prompt",
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    })
  );
  const requestId = response.headers.get("x-request-id");
  const event = requestId ? imageControl.getImageGenerationEventByRequestId(requestId) : null;

  assert.equal(response.status, 200);
  assert.ok(requestId);
  assert.equal(event?.apiKeyId, apiKey.id);
  assert.equal(event?.apiKeyName, apiKey.name);
  assert.equal(event?.provider, "openai");
  assert.equal(event?.model, "openai/gpt-image-2");
  assert.equal(event?.status, "succeeded");
  assert.equal(event?.generatedCount, 1);
  assert.equal(event?.upstreamRequestId, "upstream-image-request-1");
  assert.equal("prompt" in (event || {}), false);
  assert.equal(JSON.stringify(event).includes(apiKey.key), false);

  const upstreamHeaders = new Headers(upstreamRequest?.headers);
  const upstreamBody = JSON.parse(String(upstreamRequest?.body)) as Record<string, unknown>;
  assert.equal(upstreamHeaders.get("x-client-request-id"), requestId);
  assert.match(String(upstreamBody.user), /^[a-f0-9]{64}$/);
  assert.equal(String(upstreamBody.user).includes(apiKey.id), false);
  assert.equal("safety_identifier" in upstreamBody, false);
});

test("v1 image generation reuses the authz request id for response, upstream, and audit", async () => {
  await seedConnection("openai", { apiKey: "request-id-provider-key" });
  const apiKey = await createManagedImageKey();
  const trustedRequestId = "authz-runtime-request-id";
  let upstreamHeaders = new Headers();
  globalThis.fetch = async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    return Response.json({ created: 123, data: [{ b64_json: "cmVxdWVzdC1pZA==" }] });
  };

  const response = await imageRoute.POST(
    new Request("http://localhost/api/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.key}`,
        "Content-Type": "application/json",
        "x-request-id": trustedRequestId,
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2",
        prompt: "request id correlation",
      }),
    })
  );
  const event = imageControl.getImageGenerationEventByRequestId(trustedRequestId);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), trustedRequestId);
  assert.equal(upstreamHeaders.get("x-client-request-id"), trustedRequestId);
  assert.equal(event?.requestId, trustedRequestId);
  assert.equal(event?.status, "succeeded");
});

test("v1 image generation rejects a key whose image feature is disabled", async () => {
  await seedConnection("openai", { apiKey: "disabled-provider-key" });
  const apiKey = await createManagedImageKey();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { imageGenerationEnabled: false });
  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    return Response.json({ data: [] });
  };

  const response = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "disabled image request",
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 403);
  assert.match(body.error.message, /disabled/i);
  assert.equal(providerCalled, false);
});

test("v1 image generation enforces a per-key rolling minute limit", async () => {
  await seedConnection("openai", { apiKey: "rate-provider-key" });
  const apiKey = await createManagedImageKey();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    imageMaxRequestsPerMinute: 1,
    imageMaxRequestsPerDay: 10,
    imageMaxConcurrent: 1,
  });
  globalThis.fetch = async () =>
    Response.json({ created: 123, data: [{ b64_json: "cmF0ZS1pbWFnZQ==" }] });

  const first = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "first rate request",
    })
  );
  const second = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "second rate request",
    })
  );
  const body = (await second.json()) as any;

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.match(body.error.message, /minute|limit/i);
});

test("v1 image generation audits upstream failures and releases concurrency", async () => {
  await seedConnection("openai", { apiKey: "failure-provider-key" });
  const apiKey = await createManagedImageKey();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: "provider_down", message: "unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json", "x-request-id": "upstream-failure-1" },
    });

  const response = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "failed audit request",
    })
  );
  const requestId = response.headers.get("x-request-id");
  const event = requestId ? imageControl.getImageGenerationEventByRequestId(requestId) : null;

  assert.equal(response.status, 503);
  assert.equal(event?.status, "failed");
  assert.equal(event?.httpStatus, 503);
  assert.equal(event?.generatedCount, 0);
  assert.equal(event?.upstreamRequestId, "upstream-failure-1");

  globalThis.fetch = async () =>
    Response.json({ created: 124, data: [{ b64_json: "cmVjb3ZlcmVk" }] });
  const recovered = await imageRoute.POST(
    jsonRequestWithKey(apiKey, {
      model: "openai/gpt-image-2",
      prompt: "recovered request",
    })
  );
  assert.equal(recovered.status, 200);
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
    await authorizedJsonRequest({
      model: "topaz/topaz-enhance",
      image_url: "https://example.com/topaz-input.png",
      size: "1024x1024",
      response_format: "b64_json",
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.data[0].b64_json, "BwcH");
});

test("v1 image generation POST still requires prompts for text-input models", async () => {
  const response = await imageRoute.POST(
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      image_url: "https://example.com/source.png",
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
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "proxy test image",
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
    await authorizedJsonRequest({
      model: "openai/gpt-image-2",
      prompt: "proxy failover image",
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
    await authorizedJsonRequest({
      model: "sdwebui/stable-diffusion-v1-5",
      prompt: "no credentials test",
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
    await authorizedJsonRequest({
      model: "codex/gpt-5.5",
      prompt: "A polished product photograph",
      response_format: "b64_json",
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
    await authorizedJsonRequest({
      model: "codex/gpt-5.5",
      prompt: "A polished product photograph",
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 488_000);
  assert.match(body.error.message, /All Codex accounts.*Plus usage limit/i);
  assert.match(body.error.message_vi, /hạn mức Plus/i);
});
