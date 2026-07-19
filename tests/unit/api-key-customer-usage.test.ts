import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-customer-usage-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-customer-usage-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usage = await import("../../src/lib/usage/apiKeyCustomerUsage.ts");

const MACHINE_ID = "1234567890abcdef";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("buildApiKeyCustomerUsage returns a masked active key and 95 percent alert", async () => {
  const apiKey = await apiKeysDb.createApiKey("Alert customer", MACHINE_ID, {
    dailyTokenLimit: 200,
    commercialKey: true,
  });
  await usageHistory.saveRequestUsage({
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    provider: "codex",
    model: "gpt-5.5",
    status: "200",
    success: true,
    tokens: { input: 170, output: 20 },
  });

  const snapshot = await usage.buildApiKeyCustomerUsage(apiKey, {
    rawKeyForMasking: apiKey.key,
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  assert.equal(snapshot.key.state, "active");
  assert.equal(snapshot.key.prefix.includes("****"), true);
  assert.equal(snapshot.alerts[0]?.thresholdPercent, 95);
  assert.equal("key" in snapshot, true);
  assert.equal(JSON.stringify(snapshot).includes(apiKey.key), false);
});

test("buildApiKeyCustomerUsage returns null limits for a key with no limits", async () => {
  const apiKey = await apiKeysDb.createApiKey("Unlimited customer", MACHINE_ID, {
    commercialKey: true,
  });

  const snapshot = await usage.getApiKeyCustomerUsageById(apiKey.id, {
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  assert.notEqual(snapshot, null);
  assert.equal(snapshot.requests.limit, null);
  assert.equal(snapshot.tokens.limit, null);
  assert.equal(snapshot.tokens.daily_limit, null);
  assert.equal(snapshot.tokens.hourly_limit, null);
  assert.equal(snapshot.alerts.length, 0);
  assert.equal(snapshot.key.prefix?.includes("****"), true);
  assert.equal(JSON.stringify(snapshot).includes(apiKey.key), false);
});

test("getApiKeyCustomerUsageById returns null for a deleted key", async () => {
  const apiKey = await apiKeysDb.createApiKey("Deleted customer", MACHINE_ID, {
    commercialKey: true,
  });
  await apiKeysDb.deleteApiKey(apiKey.id);

  const snapshot = await usage.getApiKeyCustomerUsageById(apiKey.id);

  assert.equal(snapshot, null);
});
