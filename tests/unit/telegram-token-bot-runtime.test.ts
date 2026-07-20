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
const { startTelegramTokenBot } = await import("../../src/lib/telegramTokenBot/runtime.ts");

function fakeBot() {
  const fetch: typeof globalThis.fetch = async (input) => {
    const method = new URL(String(input)).pathname.split("/").at(-1);
    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "QRouter", username: "qrouter_token_bot" }
        : method === "getWebhookInfo"
          ? { url: "", has_custom_certificate: false, pending_update_count: 0 }
          : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  return new Bot("telegram-runtime-test-token", { client: { fetch } });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("runtime starts the automatic alert monitor and awaits it during shutdown", async () => {
  let monitorDeps: TelegramAlertMonitorDeps | null = null;
  let monitorInterval = 0;
  let monitorStopped = false;
  let runnerStopped = false;

  const runtime = await startTelegramTokenBot({
    bot: fakeBot(),
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
  } finally {
    await runtime.stop();
  }
  assert.equal(monitorStopped, true);
  assert.equal(runnerStopped, true);
});
