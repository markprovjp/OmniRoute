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
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const usageRoute = await import("../../src/app/api/v1/usage/route.ts");
const customerUsageRoute = await import("../../src/app/api/customer/usage/route.ts");
const customerLogsRoute = await import("../../src/app/api/customer/logs/route.ts");
const apiKeyRequestLogs = await import("../../src/lib/usage/apiKeyRequestLogs.ts");

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

test("Codex cached input is excluded from API-key quota while raw usage is retained", async () => {
  const apiKey = await apiKeysDb.createApiKey("Codex cached quota", MACHINE_ID, {
    tokenLimit: 1_000_000,
    dailyTokenLimit: 1_000_000,
    commercialKey: true,
  });
  await usageHistory.saveRequestUsage({
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    provider: "codex",
    model: "gpt-5.5",
    status: "200",
    success: true,
    tokens: {
      prompt_tokens: 3_514_237,
      completion_tokens: 18_232,
      cached_tokens: 3_393_792,
    },
  });

  const response = await usageRoute.GET(
    new Request("http://localhost/api/v1/usage", {
      headers: { authorization: `Bearer ${apiKey.key}` },
    })
  );
  const body = (await response.json()) as any;
  const db = core.getDbInstance();
  const historyRow = db
    .prepare(
      `SELECT tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation
       FROM usage_history WHERE api_key_id = ?`
    )
    .get(apiKey.id) as Record<string, number>;
  const storedKey = await apiKeysDb.getApiKeyById(apiKey.id);

  assert.equal(response.status, 200);
  assert.equal(body.tokens.total, 138_677);
  assert.equal(body.tokenQuota.used, 138_677);
  assert.equal(body.models[0].input_tokens, 120_445);
  assert.equal(body.models[0].output_tokens, 18_232);
  assert.equal(body.models[0].total_tokens, 138_677);
  assert.equal(storedKey?.tokenUsed, 138_677);
  assert.deepEqual(
    { ...historyRow },
    {
      tokens_input: 3_514_237,
      tokens_output: 18_232,
      tokens_cache_read: 3_393_792,
      tokens_cache_creation: 0,
    }
  );
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

test("POST /api/customer/usage delegates to the v1 customer usage snapshot", async () => {
  const apiKey = await apiKeysDb.createApiKey("Delegated customer route key", MACHINE_ID, {
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
    tokens: { input: 60, output: 40 },
  });

  const request = () =>
    new Request("http://localhost/api/usage", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key }),
      headers: { "content-type": "application/json" },
    });
  const [v1Response, customerResponse] = await Promise.all([
    usageRoute.POST(request()),
    customerUsageRoute.POST(request()),
  ]);
  const v1Body = (await v1Response.json()) as any;
  const customerBody = (await customerResponse.json()) as any;

  assert.equal(v1Response.status, 200);
  assert.equal(customerResponse.status, 200);
  assert.equal(customerBody.object, v1Body.object);
  assert.deepEqual(customerBody.key, v1Body.key);
  assert.deepEqual(customerBody.tokenQuota, v1Body.tokenQuota);
  assert.equal(JSON.stringify(customerBody).includes(apiKey.key), false);
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
  assert.equal(body.alerts.length, 0);
});

test("POST /api/customer/usage returns threshold alerts when token usage nears exhaustion", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer warning key", MACHINE_ID, {
    dailyTokenLimit: 200,
    expiresAt: "2026-07-21T00:00:00.000Z",
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

  const response = await customerUsageRoute.POST(
    new Request("http://localhost/api/customer/usage", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key }),
      headers: { "content-type": "application/json" },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.alerts.length, 2);
  assert.equal(body.alerts[0].metric, "daily_tokens");
  assert.equal(body.alerts[0].thresholdPercent, 95);
  assert.equal(body.alerts[1].metric, "key_expiry");
});

test("POST /api/customer/logs returns only sanitized logs for the submitted key", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer log key", MACHINE_ID, {
    commercialKey: true,
  });
  const otherApiKey = await apiKeysDb.createApiKey("Other customer log key", MACHINE_ID, {
    commercialKey: true,
  });

  await callLogs.saveCallLog({
    id: "customer-log-ok",
    timestamp: "2026-06-08T01:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "codex/gpt-5.4-mini",
    requestedModel: "cx/gpt-5.4-mini",
    provider: "codex",
    connectionId: "internal-account-id",
    duration: 1875,
    tokens: { input: 100, output: 40, cacheRead: 10, reasoning: 5 },
    requestType: "chat",
    sourceFormat: "openai",
    targetFormat: "responses",
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    requestBody: { messages: [{ role: "user", content: "private prompt" }] },
    responseBody: { id: "resp_customer" },
  });
  await callLogs.saveCallLog({
    id: "customer-log-error",
    timestamp: "2026-06-08T01:01:00.000Z",
    method: "POST",
    path: "/v1/images/generations",
    status: 504,
    model: "codex/gpt-5.4-mini",
    provider: "codex",
    duration: 120_000,
    tokens: { input: 50, output: 0 },
    requestType: "image",
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    error: new Error("Gateway timeout at C:\\secret\\internal-account-id\\worker.ts:10"),
  });
  await callLogs.saveCallLog({
    id: "other-customer-log",
    timestamp: "2026-06-08T01:02:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "codex/gpt-5.4-mini",
    provider: "codex",
    duration: 50,
    tokens: { input: 1, output: 2 },
    apiKeyId: otherApiKey.id,
    apiKeyName: otherApiKey.name,
  });

  const response = await customerLogsRoute.POST(
    new Request("http://localhost/api/customer/logs", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key, limit: 10 }),
      headers: { "content-type": "application/json" },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.object, "api_key_request_logs");
  assert.equal(body.summary.returned, 2);
  assert.equal(body.summary.errors, 1);
  assert.deepEqual(
    body.logs.map((log: any) => log.id),
    ["customer-log-error", "customer-log-ok"]
  );
  assert.equal(
    body.logs.some((log: any) => log.id === "other-customer-log"),
    false
  );
  assert.equal(body.logs[0].durationMs, 120_000);
  assert.equal(body.logs[1].tokens.input, 90);
  assert.equal(body.logs[1].tokens.output, 40);
  assert.equal(body.logs[1].tokens.cacheRead, 10);
  assert.equal(body.logs[1].tokens.reasoning, 5);
  assert.equal(body.logs[1].tokens.total, 130);

  for (const log of body.logs) {
    assert.equal("provider" in log, false);
    assert.equal("account" in log, false);
    assert.equal("connectionId" in log, false);
    assert.equal("apiKeyId" in log, false);
    assert.equal("apiKeyName" in log, false);
    assert.equal("artifactRelPath" in log, false);
    assert.equal("requestBody" in log, false);
    assert.equal("responseBody" in log, false);
  }
});

test("API-key request log pages contain ten owned rows and clamp page boundaries", async () => {
  const apiKey = await apiKeysDb.createApiKey("Paginated log key", MACHINE_ID, {
    commercialKey: true,
  });
  const otherApiKey = await apiKeysDb.createApiKey("Foreign paginated log key", MACHINE_ID, {
    commercialKey: true,
  });

  for (let index = 0; index < 23; index += 1) {
    await callLogs.saveCallLog({
      id: `page-log-${String(index).padStart(2, "0")}`,
      timestamp: `2026-06-08T01:${String(index).padStart(2, "0")}:00.000Z`,
      status: 200,
      model: `model-${index}`,
      provider: "codex",
      duration: index * 10,
      tokens: { input: index, output: 1 },
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
    });
  }
  await callLogs.saveCallLog({
    id: "foreign-page-log",
    timestamp: "2026-06-08T02:00:00.000Z",
    status: 500,
    model: "foreign-model",
    provider: "codex",
    apiKeyId: otherApiKey.id,
    apiKeyName: otherApiKey.name,
  });

  const first = apiKeyRequestLogs.getApiKeyRequestLogPage({
    apiKeyId: apiKey.id,
    page: 1,
    pageSize: 10,
  });
  const second = apiKeyRequestLogs.getApiKeyRequestLogPage({
    apiKeyId: apiKey.id,
    page: 2,
    pageSize: 10,
  });
  const clamped = apiKeyRequestLogs.getApiKeyRequestLogPage({
    apiKeyId: apiKey.id,
    page: 999,
    pageSize: 10,
  });

  assert.equal(first.total, 23);
  assert.equal(first.totalPages, 3);
  assert.equal(first.page, 1);
  assert.equal(first.logs.length, 10);
  assert.equal(first.logs[0]?.id, "page-log-22");
  assert.equal(
    first.logs.some((log) => log.id === "foreign-page-log"),
    false
  );
  assert.equal(second.page, 2);
  assert.equal(second.logs.length, 10);
  assert.equal(second.logs[0]?.id, "page-log-12");
  assert.equal(clamped.page, 3);
  assert.equal(clamped.logs.length, 3);
  assert.deepEqual(
    clamped.logs.map((log) => log.id),
    ["page-log-02", "page-log-01", "page-log-00"]
  );
});

test("POST /api/customer/logs supports status filtering and rejects invalid keys", async () => {
  const apiKey = await apiKeysDb.createApiKey("Customer log filter key", MACHINE_ID, {
    commercialKey: true,
  });
  await callLogs.saveCallLog({
    id: "customer-log-filter-ok",
    timestamp: "2026-06-08T02:00:00.000Z",
    status: 200,
    model: "codex/gpt-5.4-mini",
    provider: "codex",
    apiKeyId: apiKey.id,
  });
  await callLogs.saveCallLog({
    id: "customer-log-filter-error",
    timestamp: "2026-06-08T02:01:00.000Z",
    status: 500,
    model: "codex/gpt-5.4-mini",
    provider: "codex",
    apiKeyId: apiKey.id,
    error: "upstream failed",
  });

  const filtered = await customerLogsRoute.POST(
    new Request("http://localhost/api/customer/logs", {
      method: "POST",
      body: JSON.stringify({ apiKey: apiKey.key, status: "error", limit: 5 }),
      headers: { "content-type": "application/json" },
    })
  );
  const filteredBody = (await filtered.json()) as any;
  const invalid = await customerLogsRoute.POST(
    new Request("http://localhost/api/customer/logs", {
      method: "POST",
      body: JSON.stringify({ apiKey: "qrouter_sk_invalid" }),
      headers: { "content-type": "application/json" },
    })
  );

  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filteredBody.logs.map((log: any) => log.id),
    ["customer-log-filter-error"]
  );
  assert.equal(filteredBody.status, "error");
  assert.equal(invalid.status, 401);
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
  assert.equal(body.alerts.length, 0);
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
