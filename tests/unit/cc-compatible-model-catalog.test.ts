import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");

const CODEX_BARE_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.5-xhigh",
  "gpt-5.5-high",
  "gpt-5.5-medium",
  "gpt-5.5-low",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
] as const;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.afterEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("v1 models exposes CC-compatible fallback models under the provider node prefix", async () => {
  await providersDb.createProviderNode({
    id: "anthropic-compatible-cc-cm",
    type: "anthropic-compatible",
    name: "Claude Max",
    prefix: "cm",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/messages?beta=true",
    modelsPath: "/v1/models",
  });

  await providersDb.createProviderConnection({
    provider: "anthropic-compatible-cc-cm",
    authType: "apikey",
    name: "cm-main",
    apiKey: "sk-test",
    isActive: true,
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/messages?beta=true",
      modelsPath: "/v1/models",
    },
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", { method: "GET" })
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.ok(ids.has("cm/claude-opus-4-7"));
  assert.ok(ids.has("cm/claude-opus-4-6"));
  assert.ok(ids.has("cm/claude-sonnet-4-6"));
  assert.equal(
    [...ids].some((id) => (id as any).startsWith("anthropic-compatible-cc-cm/")),
    false
  );
});

async function seedCodexCatalog() {
  await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-main",
    accessToken: "codex-test-token",
    isActive: true,
    testStatus: "active",
  });
  await modelsDb.addCustomModel("codex", "gpt-5.6-luna", "GPT 5.6 Luna", "manual", "responses");
  await modelsDb.addCustomModel("codex", "gpt-5.6-terra", "GPT 5.6 Terra", "manual", "responses");
}

test("v1 models exposes bare aliases once for available Codex-only models", async () => {
  await seedCodexCatalog();

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", { method: "GET" })
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const ids = body.data.map((item) => item.id);

  for (const model of CODEX_BARE_MODELS) {
    assert.equal(ids.filter((id) => id === model).length, 1, model);
    assert.equal(ids.filter((id) => id === `cx/${model}`).length, 1, `cx/${model}`);
    assert.equal(ids.filter((id) => id === `codex/${model}`).length, 1, `codex/${model}`);
  }
});

test("v1 models does not expose bare Codex aliases when OpenAI is also active", async () => {
  await seedCodexCatalog();
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-main",
    apiKey: "sk-openai-test",
    isActive: true,
    testStatus: "active",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", { method: "GET" })
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  for (const model of CODEX_BARE_MODELS) {
    assert.equal(ids.has(model), false, model);
    assert.ok(ids.has(`cx/${model}`), `cx/${model}`);
    assert.ok(ids.has(`codex/${model}`), `codex/${model}`);
  }
});
