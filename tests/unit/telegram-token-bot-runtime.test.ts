import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bot } from "grammy";
import type { TelegramAlertMonitorDeps } from "../../src/lib/telegramTokenBot/alertMonitor.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-telegram-runtime-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "telegram-runtime-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const telegramDb = await import("../../src/lib/db/telegramBot.ts");
const { startTelegramTokenBot } = await import("../../src/lib/telegramTokenBot/runtime.ts");

interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

function fakeBot(calls: FakeTelegramCall[] = []) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    const payload =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, payload });
    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "QRouter", username: "qrouter_token_bot" }
        : method === "getWebhookInfo"
          ? { url: "", has_custom_certificate: false, pending_update_count: 0 }
          : method === "sendMessage"
            ? {
                message_id: calls.length,
                date: 0,
                chat: { id: payload.chat_id, type: "private" },
                text: payload.text,
              }
            : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  return new Bot("telegram-runtime-test-token", { client: { fetch } });
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: 12345, type: "private" },
      from: { id: 999, is_bot: false, first_name: "Customer" },
      text,
    },
  };
}

test.beforeEach(() => {
  apiKeysDb.resetApiKeyState();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("runtime exposes start and check, starts the alert monitor, and awaits shutdown", async () => {
  const calls: FakeTelegramCall[] = [];
  let monitorDeps: TelegramAlertMonitorDeps | null = null;
  let monitorInterval = 0;
  let monitorStopped = false;
  let runnerStopped = false;

  const runtime = await startTelegramTokenBot({
    bot: fakeBot(calls),
    env: {
      QROUTER_TELEGRAM_BOT_TOKEN: "telegram-runtime-test-token",
      QROUTER_TELEGRAM_BOT_USERNAME: "qrouter_token_bot",
    },
    ownerId: "runtime-test-owner",
    registerSignalHandlers: false,
    runBot: (() => ({
      stop: async () => {
        runnerStopped = true;
      },
    })) as never,
    startMonitor: ((deps: TelegramAlertMonitorDeps, intervalMs: number) => {
      monitorDeps = deps;
      monitorInterval = intervalMs;
      return {
        runNow: async () => null,
        stop: async () => {
          monitorStopped = true;
        },
      };
    }) as never,
  });

  try {
    assert.ok(monitorDeps);
    assert.equal(monitorInterval, 60_000);
    const setCommands = calls.find((call) => call.method === "setMyCommands");
    assert.deepEqual(setCommands?.payload.commands, [
      { command: "start", description: "Kết nối API key QRouter" },
      { command: "check", description: "Xem lại usage của key" },
    ]);
  } finally {
    await runtime.stop();
  }
  assert.equal(monitorStopped, true);
  assert.equal(runnerStopped, true);
});

test("runtime validates a submitted API key, links its ID, and deletes the Telegram message", async () => {
  const calls: FakeTelegramCall[] = [];
  const key = await apiKeysDb.createApiKey("Direct Telegram Key", "telegram-runtime-machine", {
    commercialKey: true,
  });
  const runtime = await startTelegramTokenBot({
    bot: fakeBot(calls),
    env: {
      QROUTER_TELEGRAM_BOT_TOKEN: "telegram-runtime-test-token",
      QROUTER_TELEGRAM_BOT_USERNAME: "qrouter_token_bot",
    },
    ownerId: "runtime-direct-token-owner",
    registerSignalHandlers: false,
    runBot: (() => ({ stop: async () => undefined })) as never,
    startMonitor: (() => ({ runNow: async () => null, stop: async () => undefined })) as never,
  });

  try {
    await runtime.bot.handleUpdate(textUpdate(1, key.key) as never);
    assert.equal(telegramDb.getTelegramSubscriptionByChat("12345")?.apiKeyId, key.id);
    assert.equal(
      calls.some((call) => call.method === "deleteMessage"),
      true
    );
    assert.equal(JSON.stringify(calls).includes(key.key), false);
    const usageReply = calls.find((call) => call.method === "sendMessage");
    assert.match(String(usageReply?.payload.text ?? ""), /QROUTER KEY/);
    const buttons = (
      usageReply?.payload.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      }
    )?.inline_keyboard?.flat();
    assert.deepEqual(
      buttons?.map((button) => button.callback_data),
      ["refresh_dashboard", "show_logs:1", "toggle_alerts"]
    );
  } finally {
    await runtime.stop();
  }
});
