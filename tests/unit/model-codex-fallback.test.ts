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

test("bare Codex GPT catalog models route to Codex when OpenAI is absent", async () => {
  await seedConnection("codex");

  for (const model of ["gpt-5.5-medium", "gpt-5.5-high", "gpt-5.4", "gpt-5.4-mini"]) {
    const result = await getModelInfo(model);

    assert.equal(result.provider, "codex", model);
    assert.equal(result.model, model, model);
  }
});

test("bare gpt-5.5 keeps the existing Codex medium default when OpenAI is absent", async () => {
  await seedConnection("codex");

  const result = await getModelInfo("gpt-5.5");

  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-5.5-medium");
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
