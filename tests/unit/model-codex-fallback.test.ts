import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-codex-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");

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

async function seedConnection(provider: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-fallback-test`,
    apiKey: `sk-${provider}-fallback-test`,
    isActive: true,
    testStatus: "active",
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("approved bare Codex aliases route to the exact Codex model when OpenAI is absent", async () => {
  await seedConnection("codex");

  for (const model of CODEX_BARE_MODELS) {
    const result = await getModelInfo(model);

    assert.equal(result.provider, "codex", model);
    assert.equal(result.model, model, model);
  }
});

test("unsupported bare GPT models stay on OpenAI", async () => {
  await seedConnection("codex");

  const result = await getModelInfo("gpt-4o-mini");

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4o-mini");
});

test("OpenAI stays preferred when an OpenAI connection exists", async () => {
  await seedConnection("codex");
  await seedConnection("openai");

  const result = await getModelInfo("gpt-5.4");

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.4");
});
