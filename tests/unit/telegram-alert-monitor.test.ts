import assert from "node:assert/strict";
import test from "node:test";
import type {
  TelegramAlertDeliveryUpdate,
  TelegramSubscription,
} from "../../src/lib/db/telegramBot.ts";
import { buildApiKeyUsageAlerts } from "../../src/lib/usage/apiKeyAlerts.ts";
import type { ApiKeyCustomerUsage } from "../../src/lib/usage/apiKeyCustomerUsage.ts";
import {
  runTelegramAlertSweep,
  startTelegramAlertMonitor,
  telegramAlertDedupeKey,
  type TelegramAlertMonitorDeps,
} from "../../src/lib/telegramTokenBot/alertMonitor.ts";

interface UsageOptions {
  name?: string;
  state?: "active" | "banned" | "disabled" | "expired";
  dailyLimit?: number | null;
  dailyUsed?: number;
  dailyReserved?: number;
  dailyResetAt?: string;
  lifetimeLimit?: number | null;
  lifetimeUsed?: number;
  expiresAt?: string | null;
  now?: Date;
}

interface DeliveryState {
  status: "reserved" | "sent" | "retry" | "failed";
  attemptCount: number;
  retryAt: Date | null;
  update?: TelegramAlertDeliveryUpdate;
}

function usage(options: UsageOptions = {}): ApiKeyCustomerUsage {
  const now = options.now ?? new Date("2026-07-19T00:00:00.000Z");
  const dailyLimit = options.dailyLimit ?? null;
  const dailyUsed = options.dailyUsed ?? 0;
  const dailyReserved = options.dailyReserved ?? 0;
  const lifetimeLimit = options.lifetimeLimit ?? null;
  const lifetimeUsed = options.lifetimeUsed ?? 0;
  const dailyResetAt = options.dailyResetAt ?? "2026-07-20T00:00:00.000Z";
  const expiresAt = options.expiresAt ?? null;

  return {
    key: {
      name: options.name ?? "Customer key",
      prefix: "qrouter_****test",
      state: options.state ?? "active",
      expires_at: expiresAt,
    },
    tokens: {
      limit: lifetimeLimit,
      daily_limit: dailyLimit,
      reset_at: dailyResetAt,
    },
    quotaUsage: {
      dailyTokenUsed: dailyUsed,
      dailyReservedTokens: dailyReserved,
      lifetimeTokenUsed: lifetimeUsed,
    },
    alerts: buildApiKeyUsageAlerts({
      dailyTokenLimit: dailyLimit,
      dailyTokenUsed: dailyUsed,
      dailyReservedTokens: dailyReserved,
      dailyResetAt,
      lifetimeTokenLimit: lifetimeLimit,
      lifetimeTokenUsed: lifetimeUsed,
      expiresAt,
      now,
    }),
  } as ApiKeyCustomerUsage;
}

function subscription(overrides: Partial<TelegramSubscription> = {}): TelegramSubscription {
  return {
    id: "subscription-1",
    apiKeyId: "api-key-1",
    chatId: "12345",
    mutedUntil: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function createHarness(initialUsage: ApiKeyCustomerUsage) {
  let currentUsage = initialUsage;
  let messageId = 0;
  const subscriptions = [subscription()];
  const deliveries = new Map<string, DeliveryState>();
  const messages: Array<{ chatId: string; text: string }> = [];
  const disconnected: string[] = [];

  const deps: TelegramAlertMonitorDeps = {
    listSubscriptions: () => subscriptions,
    getUsage: async () => currentUsage,
    claimDelivery: (subscriptionId, dedupeKey, now) => {
      const storageKey = `${subscriptionId}:${dedupeKey}`;
      const existing = deliveries.get(storageKey);
      if (!existing) {
        deliveries.set(storageKey, { status: "reserved", attemptCount: 0, retryAt: null });
        return { attemptCount: 0 };
      }
      if (
        existing.status === "retry" &&
        existing.retryAt &&
        existing.retryAt.getTime() <= now.getTime()
      ) {
        existing.status = "reserved";
        existing.retryAt = null;
        return { attemptCount: existing.attemptCount };
      }
      return null;
    },
    recordDelivery: (subscriptionId, dedupeKey, update) => {
      const storageKey = `${subscriptionId}:${dedupeKey}`;
      const existing = deliveries.get(storageKey);
      assert.ok(existing);
      existing.status = update.status;
      existing.attemptCount += 1;
      existing.retryAt = update.retryAt ?? null;
      existing.update = update;
      return true;
    },
    disconnect: (chatId) => {
      disconnected.push(chatId);
      return true;
    },
    sendMessage: async (chatId, text) => {
      messages.push({ chatId, text });
      messageId += 1;
      return { message_id: messageId };
    },
  };

  return {
    deps,
    deliveries,
    disconnected,
    messages,
    setUsage(next: ApiKeyCustomerUsage) {
      currentUsage = next;
    },
  };
}

test("builds stable dedupe keys for quota windows, configured limits, and expiry stages", () => {
  assert.equal(
    telegramAlertDedupeKey({
      metric: "daily_tokens",
      threshold: 95,
      resetAt: "2026-07-20T00:00:00.000Z",
      configuredLimit: 1_000,
    }),
    "daily_tokens:95:2026-07-20T00:00:00.000Z:1000"
  );
  assert.notEqual(
    telegramAlertDedupeKey({ metric: "lifetime_tokens", threshold: 90, configuredLimit: 1_000 }),
    telegramAlertDedupeKey({ metric: "lifetime_tokens", threshold: 90, configuredLimit: 2_000 })
  );
  assert.notEqual(
    telegramAlertDedupeKey({
      metric: "key_expiry",
      threshold: "7d",
      configuredLimit: "2026-07-26T00:00:00.000Z",
    }),
    telegramAlertDedupeKey({
      metric: "key_expiry",
      threshold: "1d",
      configuredLimit: "2026-07-26T00:00:00.000Z",
    })
  );
});

test("delivers exact 90, 95, and 100 percent transitions once", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 90, now }));

  await runTelegramAlertSweep(harness.deps, now);
  harness.setUsage(usage({ dailyLimit: 100, dailyUsed: 95, now }));
  await runTelegramAlertSweep(harness.deps, now);
  harness.setUsage(usage({ dailyLimit: 100, dailyUsed: 100, now }));
  await runTelegramAlertSweep(harness.deps, now);
  await runTelegramAlertSweep(harness.deps, now);

  assert.equal(harness.messages.length, 3);
  assert.match(harness.messages[0]?.text ?? "", /90%/);
  assert.match(harness.messages[1]?.text ?? "", /95%/);
  assert.match(harness.messages[2]?.text ?? "", /100%/);
});

test("combines all newly crossed thresholds into one escaped message", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(
    usage({ name: '<Ops & "Key">', dailyLimit: 100, dailyUsed: 96, now })
  );

  const result = await runTelegramAlertSweep(harness.deps, now);

  assert.equal(result.messagesSent, 1);
  assert.equal(result.alertsDelivered, 2);
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0]?.text ?? "", /90%/);
  assert.match(harness.messages[0]?.text ?? "", /95%/);
  assert.match(harness.messages[0]?.text ?? "", /&lt;Ops &amp; &quot;Key&quot;&gt;/);
  assert.equal(harness.messages[0]?.text.includes('<Ops & "Key">'), false);
});

test("re-arms daily alerts after reset and lifetime alerts after a limit change", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(
    usage({
      dailyLimit: 100,
      dailyUsed: 90,
      dailyResetAt: "2026-07-20T00:00:00.000Z",
      lifetimeLimit: 1_000,
      lifetimeUsed: 900,
      now,
    })
  );

  await runTelegramAlertSweep(harness.deps, now);
  await runTelegramAlertSweep(harness.deps, now);
  harness.setUsage(
    usage({
      dailyLimit: 100,
      dailyUsed: 90,
      dailyResetAt: "2026-07-21T00:00:00.000Z",
      lifetimeLimit: 2_000,
      lifetimeUsed: 1_800,
      now,
    })
  );
  await runTelegramAlertSweep(harness.deps, now);

  assert.equal(harness.messages.length, 2);
  assert.equal(harness.deliveries.size, 4);
});

test("delivers expiry stages only while alerts are enabled", async () => {
  const expiry = "2026-07-26T00:00:00.000Z";
  const firstNow = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ expiresAt: expiry, now: firstNow }));

  await runTelegramAlertSweep(harness.deps, firstNow);
  const oneDayNow = new Date("2026-07-25T00:00:00.000Z");
  harness.setUsage(usage({ expiresAt: expiry, now: oneDayNow }));
  await runTelegramAlertSweep(harness.deps, oneDayNow);

  const expiredNow = new Date("2026-07-26T00:00:00.001Z");
  harness.deps.listSubscriptions = () => [subscription({ mutedUntil: "9999-12-31T23:59:59.999Z" })];
  harness.setUsage(usage({ state: "expired", expiresAt: expiry, now: expiredNow }));
  const muted = await runTelegramAlertSweep(harness.deps, expiredNow);

  assert.equal(muted.skippedMuted, 1);
  assert.equal(harness.messages.length, 2);
  assert.match(harness.messages[0]?.text ?? "", /7 ngày/);
  assert.match(harness.messages[1]?.text ?? "", /1 ngày/);

  harness.deps.listSubscriptions = () => [subscription({ mutedUntil: null })];
  await runTelegramAlertSweep(harness.deps, expiredNow);
  assert.equal(harness.messages.length, 3);
  assert.match(harness.messages[2]?.text ?? "", /đã hết hạn/i);
});

test("defers every alert while muted and sends it after alerts are enabled", async () => {
  const mutedNow = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 95, now: mutedNow }));
  harness.deps.listSubscriptions = () => [subscription({ mutedUntil: "2026-07-20T00:00:00.000Z" })];

  const mutedResult = await runTelegramAlertSweep(harness.deps, mutedNow);
  assert.equal(mutedResult.skippedMuted, 1);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.deliveries.size, 0);

  const unmutedNow = new Date("2026-07-20T00:00:00.001Z");
  harness.setUsage(usage({ dailyLimit: 100, dailyUsed: 95, now: unmutedNow }));
  await runTelegramAlertSweep(harness.deps, unmutedNow);
  assert.equal(harness.messages.length, 1);
});

test("persistent delivery reservations prevent duplicate alerts after restart", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 95, now }));

  await runTelegramAlertSweep(harness.deps, now);
  const firstMessageCount = harness.messages.length;
  await runTelegramAlertSweep({ ...harness.deps }, now);

  assert.equal(firstMessageCount, 1);
  assert.equal(harness.messages.length, 1);
});

test("disables a subscription after Telegram 403", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 90, now }));
  harness.deps.sendMessage = async () => {
    throw { error_code: 403, description: "Forbidden: bot was blocked by the user" };
  };

  const result = await runTelegramAlertSweep(harness.deps, now);

  assert.equal(result.subscriptionsDisabled, 1);
  assert.deepEqual(harness.disconnected, ["12345"]);
  assert.equal(
    [...harness.deliveries.values()].every(
      (delivery) => delivery.update?.errorCode === "telegram_forbidden"
    ),
    true
  );
});

test("honors Telegram retry_after and retries a due delivery", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 90, now }));
  let attempts = 0;
  harness.deps.sendMessage = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw { error_code: 429, parameters: { retry_after: 2 } };
    }
    return { message_id: 99 };
  };

  await runTelegramAlertSweep(harness.deps, now);
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:00:01.999Z"));
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:00:02.000Z"));

  assert.equal(attempts, 2);
  assert.equal(
    [...harness.deliveries.values()].every((delivery) => delivery.status === "sent"),
    true
  );
});

test("retries transient failures with bounded attempts", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 90, now }));
  let attempts = 0;
  harness.deps.sendMessage = async () => {
    attempts += 1;
    throw new Error("socket reset");
  };

  await runTelegramAlertSweep(harness.deps, now);
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:01:00.000Z"));
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:03:00.000Z"));
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:10:00.000Z"));

  assert.equal(attempts, 3);
  assert.equal(
    [...harness.deliveries.values()].every((delivery) => delivery.status === "failed"),
    true
  );
});

test("tracks the retry budget independently for alerts combined in one message", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const harness = createHarness(usage({ dailyLimit: 100, dailyUsed: 90, now }));
  harness.deps.sendMessage = async () => {
    throw new Error("socket reset");
  };

  await runTelegramAlertSweep(harness.deps, now);
  harness.setUsage(usage({ dailyLimit: 100, dailyUsed: 95, now }));
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:01:00.000Z"));
  await runTelegramAlertSweep(harness.deps, new Date("2026-07-19T00:03:00.000Z"));

  const threshold90 = [...harness.deliveries.entries()].find(([key]) =>
    key.includes("daily_tokens:90:")
  )?.[1];
  const threshold95 = [...harness.deliveries.entries()].find(([key]) =>
    key.includes("daily_tokens:95:")
  )?.[1];
  assert.equal(threshold90?.status, "failed");
  assert.equal(threshold90?.attemptCount, 3);
  assert.equal(threshold95?.status, "retry");
  assert.equal(threshold95?.attemptCount, 2);
});

test("scheduler prevents overlapping sweeps and awaits the active sweep on stop", async () => {
  const gate = Promise.withResolvers<void>();
  let sweeps = 0;
  const harness = createHarness(usage());
  harness.deps.listSubscriptions = () => {
    sweeps += 1;
    return [subscription()];
  };
  harness.deps.getUsage = async () => {
    await gate.promise;
    return usage();
  };

  const monitor = startTelegramAlertMonitor(harness.deps, 60_000);
  await Promise.resolve();
  const overlapping = await monitor.runNow();
  assert.equal(overlapping, null);
  assert.equal(sweeps, 1);

  gate.resolve();
  await monitor.stop();
  assert.equal(sweeps, 1);
});
