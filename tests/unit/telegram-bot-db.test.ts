import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-telegram-bot-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "telegram-bot-db-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const telegramDb = await import("../../src/lib/db/telegramBot.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createKey(name = "Telegram Key") {
  return apiKeysDb.createApiKey(name, "telegram-bot-test-machine");
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("link claims persist only a hash, expire after ten minutes, and reject replay", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  const claim = telegramDb.createTelegramLinkClaim(key.id, now);

  assert.equal(claim.token.length >= 43, true);
  assert.equal(claim.expiresAt, "2026-07-19T00:10:00.000Z");
  assert.equal(JSON.stringify(telegramDb.__testListClaims()).includes(claim.token), false);

  const first = telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now);
  const replay = telegramDb.consumeTelegramLinkClaim(claim.token, "99999", now);

  assert.equal(first?.apiKeyId, key.id);
  assert.equal(first?.chatId, "12345");
  assert.equal(replay, null);

  const expired = telegramDb.createTelegramLinkClaim(key.id, now);
  assert.equal(
    telegramDb.consumeTelegramLinkClaim(
      expired.token,
      "54321",
      new Date("2026-07-19T00:10:00.001Z")
    ),
    null
  );
});

test("claim consumption creates one durable subscription per API key", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  const firstClaim = telegramDb.createTelegramLinkClaim(key.id, now);
  const secondClaim = telegramDb.createTelegramLinkClaim(key.id, now);

  const first = telegramDb.consumeTelegramLinkClaim(firstClaim.token, "12345", now);
  const second = telegramDb.consumeTelegramLinkClaim(secondClaim.token, "99999", now);

  assert.equal(first?.apiKeyId, key.id);
  assert.equal(second, null);
  assert.deepEqual(telegramDb.getTelegramSubscriptionByChat("12345"), first);
  assert.deepEqual(
    telegramDb.listActiveTelegramSubscriptions().map((subscription) => subscription.apiKeyId),
    [key.id]
  );
});

test("a claim cannot replace another API key's chat subscription", async () => {
  const firstKey = await createKey("First Telegram Key");
  const secondKey = await createKey("Second Telegram Key");
  const now = new Date("2026-07-19T00:00:00.000Z");
  const firstClaim = telegramDb.createTelegramLinkClaim(firstKey.id, now);
  const secondClaim = telegramDb.createTelegramLinkClaim(secondKey.id, now);

  assert.equal(
    telegramDb.consumeTelegramLinkClaim(firstClaim.token, "12345", now)?.apiKeyId,
    firstKey.id
  );
  assert.equal(telegramDb.consumeTelegramLinkClaim(secondClaim.token, "12345", now), null);
  assert.equal(telegramDb.getTelegramSubscriptionByChat("12345")?.apiKeyId, firstKey.id);
});

test("direct API-key linking creates an idempotent subscription and rejects unknown keys", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");

  const first = telegramDb.connectTelegramSubscription(key.id, "12345", now);
  const repeated = telegramDb.connectTelegramSubscription(key.id, "12345", now);
  const unknown = telegramDb.connectTelegramSubscription("missing-key", "99999", now);

  assert.equal(first?.apiKeyId, key.id);
  assert.deepEqual(repeated, first);
  assert.equal(unknown, null);
  assert.deepEqual(telegramDb.getTelegramSubscriptionByChat("12345"), first);
});

test("direct API-key linking rejects expired, inactive, banned, and revoked keys", async () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  const expired = await apiKeysDb.createApiKey("Expired", "telegram-bot-test-machine", {
    expiresAt: "2026-07-18T23:59:59.000Z",
  });
  const inactive = await createKey("Inactive");
  const banned = await createKey("Banned");
  const revoked = await createKey("Revoked");
  await apiKeysDb.updateApiKeyPermissions(inactive.id, { isActive: false });
  await apiKeysDb.updateApiKeyPermissions(banned.id, { isBanned: true });
  await apiKeysDb.revokeApiKey(revoked.id);

  assert.equal(telegramDb.connectTelegramSubscription(expired.id, "10001", now), null);
  assert.equal(telegramDb.connectTelegramSubscription(inactive.id, "10002", now), null);
  assert.equal(telegramDb.connectTelegramSubscription(banned.id, "10003", now), null);
  assert.equal(telegramDb.connectTelegramSubscription(revoked.id, "10004", now), null);
  assert.deepEqual(telegramDb.listActiveTelegramSubscriptions(), []);
});

test("subscriptions can be muted and disconnected", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  const claim = telegramDb.createTelegramLinkClaim(key.id, now);
  const subscription = telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now);
  assert.ok(subscription);

  const mutedUntil = new Date("2026-07-20T00:00:00.000Z");
  assert.equal(telegramDb.setTelegramMute("12345", mutedUntil, now), true);
  assert.equal(
    telegramDb.getTelegramSubscriptionByChat("12345")?.mutedUntil,
    mutedUntil.toISOString()
  );
  assert.equal(telegramDb.disconnectTelegramSubscription("12345", now), true);
  assert.equal(telegramDb.getTelegramSubscriptionByChat("12345"), null);
  assert.deepEqual(telegramDb.listActiveTelegramSubscriptions(), []);
});

test("alert delivery records stable failure codes and attempt counts", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  const claim = telegramDb.createTelegramLinkClaim(key.id, now);
  const subscription = telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now);
  assert.ok(subscription);

  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "daily_tokens:90", now),
    true
  );
  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "daily_tokens:90", now),
    false
  );
  assert.throws(
    () =>
      telegramDb.recordTelegramAlertDelivery(
        subscription.id,
        "daily_tokens:90",
        {
          status: "failed",
          errorCode: "Telegram API said too many requests" as never,
        },
        now
      ),
    /Unsupported Telegram alert error code/
  );
  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      {
        status: "retry",
        errorCode: "telegram_rate_limited",
        retryAt: new Date("2026-07-19T00:01:00.000Z"),
      },
      now
    ),
    true
  );
  assert.deepEqual(telegramDb.__testGetTelegramAlertDelivery(subscription.id, "daily_tokens:90"), {
    attemptCount: 1,
    deliveredAt: null,
    lastErrorCode: "telegram_rate_limited",
    retryAt: "2026-07-19T00:01:00.000Z",
    status: "retry",
    telegramMessageId: null,
  });
  assert.equal(
    telegramDb.claimTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      new Date("2026-07-19T00:00:59.999Z")
    ),
    null
  );
  assert.deepEqual(
    telegramDb.claimTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      new Date("2026-07-19T00:01:00.000Z")
    ),
    { attemptCount: 1 }
  );

  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      {
        status: "sent",
        telegramMessageId: "777",
        errorCode: "telegram_rate_limited",
        retryAt: new Date("2026-07-19T00:03:00.000Z"),
      },
      new Date("2026-07-19T00:02:00.000Z")
    ),
    true
  );
  assert.deepEqual(telegramDb.__testGetTelegramAlertDelivery(subscription.id, "daily_tokens:90"), {
    attemptCount: 2,
    deliveredAt: "2026-07-19T00:02:00.000Z",
    lastErrorCode: null,
    retryAt: null,
    status: "sent",
    telegramMessageId: "777",
  });

  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      {
        status: "retry",
        errorCode: "network_error",
        retryAt: new Date("2026-07-19T00:04:00.000Z"),
      },
      new Date("2026-07-19T00:03:00.000Z")
    ),
    true
  );
  assert.deepEqual(telegramDb.__testGetTelegramAlertDelivery(subscription.id, "daily_tokens:90"), {
    attemptCount: 3,
    deliveredAt: null,
    lastErrorCode: "network_error",
    retryAt: "2026-07-19T00:04:00.000Z",
    status: "retry",
    telegramMessageId: null,
  });

  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      {
        status: "failed",
        errorCode: "telegram_upstream_error",
        retryAt: new Date("2026-07-19T00:05:00.000Z"),
      },
      new Date("2026-07-19T00:04:00.000Z")
    ),
    true
  );
  assert.deepEqual(telegramDb.__testGetTelegramAlertDelivery(subscription.id, "daily_tokens:90"), {
    attemptCount: 4,
    deliveredAt: null,
    lastErrorCode: "telegram_upstream_error",
    retryAt: null,
    status: "failed",
    telegramMessageId: null,
  });
});

test("stale reserved alert deliveries are reclaimable after a crashed sweep", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  const claim = telegramDb.createTelegramLinkClaim(key.id, now);
  const subscription = telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now);
  assert.ok(subscription);

  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "daily_tokens:90", now),
    true
  );
  assert.equal(
    telegramDb.claimTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      new Date("2026-07-19T00:04:59.999Z")
    ),
    null
  );
  assert.deepEqual(
    telegramDb.claimTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      new Date("2026-07-19T00:05:00.000Z")
    ),
    { attemptCount: 0 }
  );
});

test("the singleton bot state preserves an advancing cursor across lease operations", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

  assert.equal(telegramDb.getTelegramLastProcessedUpdateId(), null);
  assert.equal(telegramDb.setTelegramLastProcessedUpdateId(42, now), true);
  assert.equal(telegramDb.getTelegramLastProcessedUpdateId(), 42);
  assert.equal(telegramDb.setTelegramLastProcessedUpdateId(41, now), false);
  assert.equal(telegramDb.getTelegramLastProcessedUpdateId(), 42);

  assert.equal(telegramDb.acquireTelegramBotLease("worker-a", now, 60_000), true);
  assert.equal(telegramDb.acquireTelegramBotLease("worker-b", now, 60_000), false);
  assert.equal(telegramDb.renewTelegramBotLease("worker-b", now, 60_000), false);
  assert.equal(telegramDb.renewTelegramBotLease("worker-a", now, 60_000), true);
  assert.equal(
    telegramDb.acquireTelegramBotLease("worker-b", new Date("2026-07-19T00:01:00.001Z"), 60_000),
    true
  );
  assert.equal(telegramDb.releaseTelegramBotLease("worker-a"), false);
  assert.equal(telegramDb.releaseTelegramBotLease("worker-b"), true);
  assert.equal(telegramDb.getTelegramLastProcessedUpdateId(), 42);
});

test("cleanup removes expired claims and old successful deliveries only", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  telegramDb.createTelegramLinkClaim(key.id, new Date("2026-07-18T23:48:00.000Z"));
  telegramDb.createTelegramLinkClaim(key.id, now);
  const subscriptionClaim = telegramDb.createTelegramLinkClaim(key.id, now);
  const subscription = telegramDb.consumeTelegramLinkClaim(subscriptionClaim.token, "12345", now);
  assert.ok(subscription);

  const oldDeliveryTime = new Date("2026-06-17T23:59:59.999Z");
  const recentDeliveryTime = new Date("2026-06-19T00:00:00.000Z");
  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "old-success", oldDeliveryTime),
    true
  );
  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "old-success",
      { status: "sent", telegramMessageId: "old" },
      oldDeliveryTime
    ),
    true
  );
  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "recent-success", recentDeliveryTime),
    true
  );
  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "recent-success",
      { status: "sent", telegramMessageId: "recent" },
      recentDeliveryTime
    ),
    true
  );
  assert.equal(
    telegramDb.reserveTelegramAlertDelivery(subscription.id, "pending", oldDeliveryTime),
    true
  );

  assert.deepEqual(telegramDb.cleanupTelegramBotState({ now, retentionDays: 30 }), {
    expiredClaimsDeleted: 1,
    successfulDeliveriesDeleted: 1,
  });
  const remainingClaims = telegramDb.__testListClaims();
  assert.equal(remainingClaims.length, 2);
  assert.equal(
    remainingClaims.every((claim) => Number(claim.expiresAt) > now.getTime()),
    true
  );
  assert.equal(telegramDb.__testGetTelegramAlertDelivery(subscription.id, "old-success"), null);
  assert.equal(
    telegramDb.__testGetTelegramAlertDelivery(subscription.id, "recent-success")?.status,
    "sent"
  );
  assert.equal(
    telegramDb.__testGetTelegramAlertDelivery(subscription.id, "pending")?.status,
    "reserved"
  );
});

test("cleanup respects the requested batch limit", async () => {
  const key = await createKey();
  const now = new Date("2026-07-19T00:00:00.000Z");
  for (let index = 0; index < 3; index += 1) {
    telegramDb.createTelegramLinkClaim(key.id, new Date(`2026-07-18T23:4${index}:00.000Z`));
  }

  assert.deepEqual(telegramDb.cleanupTelegramBotState({ now, retentionDays: 30, limit: 2 }), {
    expiredClaimsDeleted: 2,
    successfulDeliveriesDeleted: 0,
  });
  assert.equal(telegramDb.__testListClaims().length, 1);
});
