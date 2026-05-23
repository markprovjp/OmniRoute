import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-quota-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const quotaLedger = await import("../../src/lib/usage/apiKeyQuotaLedger.ts");

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

test("daily token reservations prevent share-key quota overshoot", async () => {
  const key = await apiKeysDb.createApiKey("Shared day key", MACHINE_ID, {
    commercialKey: true,
    dailyTokenLimit: 100,
    maxRequestsPerDay: 4,
  });

  const first = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 70,
    requestId: "req-first",
    model: "cx/gpt-5.5",
  });
  const second = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 40,
    requestId: "req-second",
    model: "cx/gpt-5.5",
  });
  const snapshot = quotaLedger.getApiKeyQuotaSnapshot(key.id);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "daily_token_limit");
  assert.equal(snapshot.day?.reservedTokens, 70);
  assert.equal(snapshot.day?.usedTokens, 0);
  assert.equal(snapshot.day?.remainingTokens, 30);
});

test("settlement moves reserved tokens into ledger usage and release restores capacity", async () => {
  const key = await apiKeysDb.createApiKey("Settled shared key", MACHINE_ID, {
    commercialKey: true,
    dailyTokenLimit: 100,
    hourlyTokenLimit: 80,
  });
  const reservation = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 60,
    requestId: "req-settle",
    model: "cx/gpt-5.5",
  });
  assert.equal(reservation.allowed, true);
  if (!reservation.allowed) return;

  quotaLedger.settleApiKeyUsageReservation({
    reservationId: reservation.reservationId,
    actualTokens: 42,
    inputTokens: 30,
    outputTokens: 12,
    usageSource: "actual",
  });

  const releasable = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 25,
    requestId: "req-release",
    model: "cx/gpt-5.5",
  });
  assert.equal(releasable.allowed, true);
  if (!releasable.allowed) return;
  quotaLedger.releaseApiKeyUsageReservation(releasable.reservationId, "upstream_failed");

  const snapshot = quotaLedger.getApiKeyQuotaSnapshot(key.id);
  const ledger = quotaLedger.getApiKeyUsageLedger(key.id);
  const stored = await apiKeysDb.getApiKeyById(key.id);

  assert.equal(snapshot.day?.usedTokens, 42);
  assert.equal(snapshot.day?.reservedTokens, 0);
  assert.equal(snapshot.hour?.usedTokens, 42);
  assert.equal(snapshot.hour?.reservedTokens, 0);
  assert.equal(stored?.tokenUsed, 42);
  assert.deepEqual(
    ledger.map((entry) => ({ tokens: entry.tokens, usageSource: entry.usageSource })),
    [{ tokens: 42, usageSource: "actual" }]
  );
});

test("lifetime token reservations also prevent concurrent share-key overshoot", async () => {
  const key = await apiKeysDb.createApiKey("Lifetime shared key", MACHINE_ID, {
    commercialKey: true,
    tokenLimit: 100,
  });

  const first = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 70,
    requestId: "req-life-first",
  });
  const second = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 40,
    requestId: "req-life-second",
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "lifetime_token_limit");
});

test("daily request quota is reserved atomically for share keys", async () => {
  const key = await apiKeysDb.createApiKey("Request limited key", MACHINE_ID, {
    commercialKey: true,
    dailyTokenLimit: 1_000,
    maxRequestsPerDay: 1,
  });

  const first = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 10,
    requestId: "req-only",
  });
  const second = quotaLedger.reserveApiKeyUsage({
    apiKeyId: key.id,
    estimatedTokens: 10,
    requestId: "req-blocked",
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "daily_request_limit");
});
