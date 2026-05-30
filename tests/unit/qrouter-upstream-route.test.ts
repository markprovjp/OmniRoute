import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-qrouter-upstream-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-qrouter-upstream-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const qrouterRoute = await import("../../src/app/api/qrouter-upstream/route.ts");
const srcModel = await import("../../src/sse/services/model.ts");

async function resetStorage() {
  delete process.env.INITIAL_PASSWORD;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function makePost(body: unknown) {
  return new Request("http://localhost/api/qrouter-upstream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("POST /api/qrouter-upstream defaults external keys to qrouter prefix", async () => {
  const response = await qrouterRoute.POST(makePost({ apiKeys: ["sk-external"] }));
  const body = (await response.json()) as any;

  assert.equal(response.status, 201);
  assert.equal(body.upstream.prefix, "qrouter");
  assert.equal(body.upstream.model, "qrouter/gpt-5.5");
  assert.equal(body.upstream.externalFirstModel, "cx/gpt-5.5");

  const nodes = await localDb.getProviderNodes({ type: "openai-compatible" });
  const qrouterNode = nodes.find((node: any) => node.baseUrl === "https://shopapikey.com/v1");
  assert.equal(qrouterNode?.prefix, "qrouter");

  const connections = await localDb.getProviderConnections({ provider: body.upstream.providerId });
  assert.equal(connections[0]?.providerSpecificData?.codexNativeCompatible, true);
  assert.equal(connections[0]?.providerSpecificData?.fetchStartTimeoutMs, 30_000);
  assert.equal(connections[0]?.providerSpecificData?.modelAlias, "cx/gpt-5.5");

  const combo = await localDb.getComboByName("cx/gpt-5.5");
  assert.equal(combo?.strategy, "priority");
  assert.equal(combo?.context_length, 1_050_000);
  assert.equal(combo?.config?.skipAvailabilityPrecheck, true);
  assert.deepEqual(
    combo?.models.map((step: any) => step.model),
    ["qrouter/gpt-5.5", "cx/gpt-5.5"]
  );
  assert.deepEqual(
    combo?.models.map((step: any) => step.providerId),
    ["qrouter", "codex"]
  );
});

test("POST /api/qrouter-upstream migrates legacy cx shopapikey node away from Codex alias", async () => {
  const legacyNode = await localDb.createProviderNode({
    id: "openai-compatible-responses-legacy-shopapikey",
    type: "openai-compatible",
    name: "9Router",
    prefix: "cx",
    apiType: "responses",
    baseUrl: "https://shopapikey.com/v1",
  });

  const before = await srcModel.getModelInfo("cx/gpt-5.5");
  assert.deepEqual(before, { provider: "codex", model: "gpt-5.5", extendedContext: false });

  const response = await qrouterRoute.POST(makePost({ apiKeys: ["sk-new-external"] }));
  const body = (await response.json()) as any;
  const updatedNodes = await localDb.getProviderNodes({ type: "openai-compatible" });
  const updatedNode = updatedNodes.find((node: any) => node.id === legacyNode.id);

  assert.equal(response.status, 201);
  assert.equal(body.upstream.providerId, legacyNode.id);
  assert.equal(body.upstream.prefix, "qrouter");
  assert.equal(updatedNode?.prefix, "qrouter");
});
