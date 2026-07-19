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

  const [first, replay] = await Promise.all([
    Promise.resolve().then(() => telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now)),
    Promise.resolve().then(() => telegramDb.consumeTelegramLinkClaim(claim.token, "99999", now)),
  ]);

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

test("alert delivery reservations deduplicate per subscription", async () => {
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
  assert.equal(
    telegramDb.recordTelegramAlertDelivery(
      subscription.id,
      "daily_tokens:90",
      {
        status: "sent",
        telegramMessageId: "777",
      },
      now
    ),
    true
  );
});

test("the singleton bot lease is owner-bound and can be taken over after expiry", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");

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
});
