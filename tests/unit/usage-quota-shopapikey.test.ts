import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-shopapikey-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-shopapikey-quota-secret";

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const quotaRoute = await import("../../src/app/api/usage/quota/route.ts");
const shopApiKeyUsage = await import("../../src/lib/usage/shopApiKeyUsage.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  shopApiKeyUsage.__resetShopApiKeyUsageCacheForTests();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

test("parseShopApiKeyUsageSnapshot keeps request and token quota", () => {
  const snapshot = shopApiKeyUsage.parseShopApiKeyUsageSnapshot({
    success: true,
    checkedAt: "2026-05-22T15:15:51.587Z",
    usage: {
      requestQuota: {
        limit: 6000,
        used: 3569,
        remaining: 2431,
        resetAt: "2026-05-22T17:00:00.000Z",
      },
      tokenQuota: {
        limit: 329000000,
        used: 193849495,
        reserved: 0,
        effectiveUsed: 193849495,
        remaining: 135150505,
      },
    },
  });

  assert.equal(snapshot?.requestQuota?.limit, 6000);
  assert.equal(snapshot?.requestQuota?.remaining, 2431);
  assert.equal(snapshot?.tokenQuota?.used, 193849495);
  assert.equal(snapshot?.tokenQuota?.remaining, 135150505);
  assert.equal(snapshot?.checkedAt, "2026-05-22T15:15:51.587Z");
});

test("GET /api/usage/quota exposes shopapikey per-key token and request quota", async () => {
  const provider = "openai-compatible-chat-shopapikey-test";
  let connectionId = "";
  await localDb.createProviderNode({
    id: provider,
    type: "openai-compatible",
    name: "9Router",
    prefix: "cx",
    apiType: "responses",
    baseUrl: "https://shopapikey.com/v1",
  });
  const connection = await localDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: "9Router key",
    apiKey: "sk-test-shopapikey",
    priority: 1,
    providerSpecificData: { baseUrl: "https://shopapikey.com/v1" },
    isActive: true,
    testStatus: "active",
  });
  connectionId = String(connection?.id || "");

  let requestCount = 0;
  globalThis.fetch = (async (input, init) => {
    requestCount++;
    assert.equal(String(input), "https://shopapikey.com/api/public/usage");
    assert.deepEqual(JSON.parse(String(init?.body)), { apiKey: "sk-test-shopapikey" });
    return Response.json({
      success: true,
      checkedAt: "2026-05-22T15:15:51.587Z",
      usage: {
        requestQuota: {
          limit: 6000,
          used: 3569,
          remaining: 2431,
          resetAt: "2026-05-22T17:00:00.000Z",
        },
        tokenQuota: {
          limit: 329000000,
          used: 193849495,
          reserved: 0,
          effectiveUsed: 193849495,
          remaining: 135150505,
          resetAt: "2026-05-22T17:00:00.000Z",
        },
      },
    });
  }) as typeof fetch;

  const response = await quotaRoute.GET(
    new Request(`http://localhost/api/usage/quota?provider=${encodeURIComponent(provider)}`)
  );
  const body = await response.json();
  const entry = body.providers[0];

  assert.equal(response.status, 200);
  assert.equal(requestCount, 1);
  assert.equal(entry.connectionId, connectionId);
  assert.equal(entry.quotaSource, "shopapikey-public-usage");
  assert.equal(entry.requestQuota.limit, 6000);
  assert.equal(entry.requestQuota.remaining, 2431);
  assert.equal(entry.tokenQuota.used, 193849495);
  assert.equal(entry.tokenQuota.remaining, 135150505);
  assert.equal(entry.quotaTotal, 329000000);
  assert.equal(entry.quotaUsed, 193849495);

  const snapshots = localDb.getQuotaSnapshots({
    connectionId,
    since: "2026-05-22T00:00:00.000Z",
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.windowKey).sort(), [
    "shopapikey:requests",
    "shopapikey:tokens",
  ]);
});
