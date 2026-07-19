import test from "node:test";
import assert from "node:assert/strict";

const alerts = await import("../../src/lib/usage/apiKeyAlerts.ts");

test("buildApiKeyUsageAlerts returns daily and expiry warnings when thresholds are reached", () => {
  const result = alerts.buildApiKeyUsageAlerts({
    dailyTokenLimit: 1_000,
    dailyTokenUsed: 880,
    dailyReservedTokens: 40,
    dailyResetAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-07-22T00:00:00.000Z",
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  assert.equal(result.length, 2);
  assert.equal(result[0]?.metric, "daily_tokens");
  assert.equal(result[0]?.thresholdPercent, 90);
  assert.equal(Math.round(result[0]?.usedPercent ?? 0), 92);
  assert.equal(result[1]?.metric, "key_expiry");
});

test("dispatchApiKeyThresholdAlerts emits each threshold once per reset window", async () => {
  const calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const dispatch = async (event: string, payload: Record<string, unknown>) => {
    calls.push({ event, payload });
  };

  await alerts.dispatchApiKeyThresholdAlerts({
    apiKeyId: "key-1",
    apiKeyName: "Customer A",
    maskedKey: "qrouter_sk_****",
    dailyTokenLimit: 100,
    dailyTokenUsed: 91,
    dailyReservedTokens: 0,
    dailyResetAt: "2026-07-20T00:00:00.000Z",
    lifetimeTokenLimit: 1_000,
    lifetimeTokenUsed: 100,
    now: new Date("2026-07-19T00:00:00.000Z"),
    dispatch,
  });
  await alerts.dispatchApiKeyThresholdAlerts({
    apiKeyId: "key-1",
    apiKeyName: "Customer A",
    maskedKey: "qrouter_sk_****",
    dailyTokenLimit: 100,
    dailyTokenUsed: 99,
    dailyReservedTokens: 0,
    dailyResetAt: "2026-07-20T00:00:00.000Z",
    lifetimeTokenLimit: 1_000,
    lifetimeTokenUsed: 100,
    now: new Date("2026-07-19T00:30:00.000Z"),
    dispatch,
  });
  await alerts.dispatchApiKeyThresholdAlerts({
    apiKeyId: "key-1",
    apiKeyName: "Customer A",
    maskedKey: "qrouter_sk_****",
    dailyTokenLimit: 100,
    dailyTokenUsed: 100,
    dailyReservedTokens: 0,
    dailyResetAt: "2026-07-20T00:00:00.000Z",
    lifetimeTokenLimit: 1_000,
    lifetimeTokenUsed: 100,
    now: new Date("2026-07-19T00:40:00.000Z"),
    dispatch,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.payload.thresholdPercent),
    [90, 95, 100]
  );
});
