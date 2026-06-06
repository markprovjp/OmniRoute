import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-usage-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-usage-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const quotaLedger = await import("../../src/lib/usage/apiKeyQuotaLedger.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageRoute = await import("../../src/app/api/v1/usage/route.ts");
const customerUsageRoute = await import("../../src/app/api/customer/usage/route.ts");

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

test("GET /api/v1/usage returns request and token quota for the bearer API key", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer A", MACHINE_ID, {
    customerName: "Customer A",
    tokenLimit: 1000,
    dailyTokenLimit: 500,
    commercialKey: true,
  });
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { maxRequestsPerDay: 25 });
  await usageHistory.saveRequestUsage({
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    provider: "codex",
    model: "gpt-5.5",
    status: "200",
    success: true,
    tokens: { input: 120, output: 30 },
  });

  const response = await usageRoute.GET(
    new Request("http://localhost/api/v1/usage", {
      headers: { authorization: `Bearer ${apiKey.key}` },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.object, "api_key_usage");
  assert.equal(body.key.name, "Customer A");
  assert.equal(body.key.prefix.includes("****"), true);
  assert.equal(body.requests.today, 1);
  assert.equal(body.requests.hour, 1);
  assert.equal(body.requests.total, 1);
  assert.equal(body.requests.limit, 25);
  assert.equal(body.requests.remaining, 24);
  assert.equal(body.tokens.total, 150);
  assert.equal(body.usage.all.totalGptTokens, 150);
  assert.equal(body.requestQuota.remaining, 24);
  assert.equal(body.tokenQuota.remaining, 350);
  assert.equal(body.tokenQuota.limit, 500);
  assert.equal(body.tokenQuota.used, 150);
  assert.equal(body.tokens.daily_limit, 500);
  assert.equal(body.tokens.daily_remaining, 350);
  assert.equal(body.tokens.limit, 1000);
  assert.equal(body.tokens.remaining, 850);
  assert.deepEqual(body.models[0], {
    model: "gpt-5.5",
    requests: 1,
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    last_used_at: body.models[0].last_used_at,
  });
});

test("POST /api/v1/usage accepts a key body for dashboard-style public usage checks", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer B", MACHINE_ID, {
    customerName: "Customer B",
    tokenLimit: 500,
    commercialKey: true,
  });
  await usageHistory.saveRequestUsage({
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    provider: "codex",
    model: "gpt-5.5",
    status: "200",
    success: true,
    tokens: { input: 50, output: 25 },
  });

  const response = await usageRoute.POST(
    new Request("http://localhost/api/v1/usage", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key }),
      headers: { "content-type": "application/json" },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.usage.today.totalGptTokens, 75);
  assert.equal(body.tokenQuota.used, 75);
  assert.equal(body.tokenQuota.remaining, 425);
});

test("POST /api/customer/usage reuses the public customer usage check", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer portal key", MACHINE_ID, {
    dailyTokenLimit: 250,
    commercialKey: true,
  });
  await usageHistory.saveRequestUsage({
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    provider: "codex",
    model: "gpt-5.5",
    status: "200",
    success: true,
    tokens: { input: 40, output: 10 },
  });

  const response = await customerUsageRoute.POST(
    new Request("http://localhost/api/customer/usage", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key }),
      headers: { "content-type": "application/json" },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.key.prefix.includes("****"), true);
  assert.equal(body.tokenQuota.used, 50);
  assert.equal(body.tokenQuota.remaining, 200);
});

test("GET /api/v1/usage includes request reservations in daily quota usage", async () => {
  const apiKey = await apiKeysDb.createApiKey("Reserved request key", MACHINE_ID, {
    commercialKey: true,
    dailyTokenLimit: 1_000,
    maxRequestsPerDay: 2,
  });

  const reservation = quotaLedger.reserveApiKeyUsage({
    apiKeyId: apiKey.id,
    estimatedTokens: 100,
    requestId: "req-live-reservation",
  });
  assert.equal(reservation.allowed, true);

  const response = await usageRoute.GET(
    new Request("http://localhost/api/v1/usage", {
      headers: { authorization: `Bearer ${apiKey.key}` },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.requests.today, 1);
  assert.equal(body.requests.total, 0);
  assert.equal(body.requestQuota.used, 1);
  assert.equal(body.requestQuota.remaining, 1);
  assert.equal(body.tokenQuota.reserved, 100);
});

test("GET /api/v1/usage rejects missing or invalid bearer keys", async () => {
  const missing = await usageRoute.GET(new Request("http://localhost/api/v1/usage"));
  const invalid = await usageRoute.GET(
    new Request("http://localhost/api/v1/usage", {
      headers: { authorization: "Bearer qrouter_sk_invalid" },
    })
  );

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
});
