import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-telegram-link-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-telegram-link-route-secret";
const ORIGINAL_TELEGRAM_BOT_USERNAME = process.env.QROUTER_TELEGRAM_BOT_USERNAME;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const telegramDb = await import("../../src/lib/db/telegramBot.ts");
const telegramLinkRoute = await import("../../src/app/api/customer/telegram-link/route.ts");

const MACHINE_ID = "1234567890abcdef";

function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createKey(name = "Telegram link customer") {
  return apiKeysDb.createApiKey(name, MACHINE_ID, { commercialKey: true });
}

function requestWith(body: unknown) {
  return new Request("http://localhost/api/customer/telegram-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.beforeEach(() => {
  resetStorage();
  delete process.env.QROUTER_TELEGRAM_BOT_USERNAME;
});

test.after(() => {
  resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_TELEGRAM_BOT_USERNAME === undefined) {
    delete process.env.QROUTER_TELEGRAM_BOT_USERNAME;
  } else {
    process.env.QROUTER_TELEGRAM_BOT_USERNAME = ORIGINAL_TELEGRAM_BOT_USERNAME;
  }
});

test("POST /api/customer/telegram-link rejects missing and invalid keys generically", async () => {
  const missing = await telegramLinkRoute.POST(requestWith({}));
  const nullBody = await telegramLinkRoute.POST(requestWith(null));
  const invalid = await telegramLinkRoute.POST(requestWith({ apiKey: "qrouter_sk_invalid" }));

  assert.equal(missing.status, 401);
  assert.equal(nullBody.status, 401);
  assert.equal(invalid.status, 401);
  assert.deepEqual(await missing.json(), { error: "Unauthorized" });
  assert.deepEqual(await nullBody.json(), { error: "Unauthorized" });
  assert.deepEqual(await invalid.json(), { error: "Unauthorized" });
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(invalid.headers.get("cache-control"), "no-store");
});

test("POST /api/customer/telegram-link rejects ineligible key lifecycles", async () => {
  const inactive = await createKey("Inactive");
  await apiKeysDb.updateApiKeyPermissions(inactive.id, { isActive: false });

  const revoked = await createKey("Revoked");
  await apiKeysDb.revokeApiKey(revoked.id);

  const banned = await createKey("Banned");
  await apiKeysDb.updateApiKeyPermissions(banned.id, { isBanned: true });

  const expired = await createKey("Expired");
  await apiKeysDb.setApiKeyExpiry(expired.id, new Date(Date.now() - 60_000).toISOString());

  for (const apiKey of [inactive, revoked, banned, expired]) {
    const response = await telegramLinkRoute.POST(requestWith({ key: apiKey.key }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  assert.deepEqual(telegramDb.__testListClaims(), []);
});

test("POST /api/customer/telegram-link caps body keys before lookup", async () => {
  const response = await telegramLinkRoute.POST(requestWith({ apiKey: "k".repeat(1025) }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.deepEqual(telegramDb.__testListClaims(), []);
});

test("POST /api/customer/telegram-link issues a no-store default-bot claim without logging secrets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-19T00:00:00.000Z") });
  const apiKey = await createKey();
  const logged: unknown[][] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logged.push(args);
  console.warn = (...args: unknown[]) => logged.push(args);
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    const response = await telegramLinkRoute.POST(requestWith({ apiKey: apiKey.key }));
    const body = (await response.json()) as {
      success: boolean;
      deepLink: string;
      expiresAt: string;
    };
    const token = body.deepLink.split("?start=")[1] ?? "";

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.success, true);
    assert.match(body.deepLink, /^https:\/\/t\.me\/qrouter_token_bot\?start=[A-Za-z0-9_-]{43}$/);
    assert.equal(body.expiresAt, "2026-07-19T00:10:00.000Z");
    assert.equal(JSON.stringify(body).includes(apiKey.key), false);
    assert.equal(JSON.stringify(telegramDb.__testListClaims()).includes(apiKey.key), false);
    assert.equal(JSON.stringify(telegramDb.__testListClaims()).includes(token), false);
    assert.equal(JSON.stringify(logged).includes(apiKey.key), false);
    assert.equal(JSON.stringify(logged).includes(token), false);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
