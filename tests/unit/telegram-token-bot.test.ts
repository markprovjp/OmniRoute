import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { createTelegramTokenBot } from "../../src/lib/telegramTokenBot/bot.ts";

interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

function createFakeTelegramApi() {
  const calls: FakeTelegramCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    const body = init?.body;
    const payload =
      typeof body === "string"
        ? (JSON.parse(body) as Record<string, unknown>)
        : body instanceof URLSearchParams
          ? Object.fromEntries(body.entries())
          : {};
    calls.push({ method, payload });

    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "QRouter", username: "qrouter_token_bot" }
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

  return { calls, fetch };
}

function commandUpdate(updateId: number, text: string, chatType: "private" | "group" = "private") {
  const command = text.split(" ")[0] ?? text;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: 12345, type: chatType },
      from: { id: 999, is_bot: false, first_name: "Customer" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

function callbackUpdate(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 999, is_bot: false, first_name: "Customer" },
      chat_instance: "fake-chat",
      data,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: 12345, type: "private" },
      },
    },
  };
}

function createSubject() {
  const fakeTelegram = createFakeTelegramApi();
  const subscriptions = new Map<string, { apiKeyId: string; mutedUntil: string | null }>();
  const bot = new Bot("telegram-test-token", { client: { fetch: fakeTelegram.fetch } });
  bot.botInfo = { id: 1, is_bot: true, first_name: "QRouter", username: "qrouter_token_bot" };
  const usage = {
    key: { name: '<Ops & "Key">', prefix: "qrouter_****mask", state: "active" },
    tokens: { today: 12_345, remaining: 987_655, limit: 1_000_000 },
    alerts: [{ title: "Daily <limit>", message: "90% & rising" }],
  };

  createTelegramTokenBot({
    bot,
    consumeClaim: (token, chatId) => {
      if (token !== "valid-claim") return null;
      const subscription = { apiKeyId: "api-key-id", mutedUntil: null };
      subscriptions.set(chatId, subscription);
      return { id: "subscription-id", chatId, ...subscription, createdAt: "", updatedAt: "" };
    },
    getSubscription: (chatId) => {
      const subscription = subscriptions.get(chatId);
      return subscription
        ? { id: "subscription-id", chatId, ...subscription, createdAt: "", updatedAt: "" }
        : null;
    },
    setMute: (chatId, mutedUntil) => {
      const subscription = subscriptions.get(chatId);
      if (!subscription) return false;
      subscription.mutedUntil = mutedUntil?.toISOString() ?? null;
      return true;
    },
    disconnect: (chatId) => subscriptions.delete(chatId),
    getUsage: async () => usage as never,
  });

  return { bot, calls: fakeTelegram.calls, subscriptions };
}

function messages(calls: FakeTelegramCall[]) {
  return calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => String(call.payload.text));
}

test("claims only in a private chat and replies generically for invalid claims", async () => {
  const { bot, calls, subscriptions } = createSubject();

  await bot.handleUpdate(commandUpdate(1, "/start valid-claim") as never);
  await bot.handleUpdate(commandUpdate(2, "/start valid-claim", "group") as never);
  await bot.handleUpdate(commandUpdate(3, "/start invalid-claim") as never);

  assert.equal(subscriptions.has("12345"), true);
  assert.equal(messages(calls).length, 2);
  assert.match(messages(calls)[0] ?? "", /Đã kết nối/);
  assert.equal(messages(calls)[1], "Không thể kết nối. Hãy tạo liên kết mới trên QRouter.");
  assert.equal(JSON.stringify(calls).includes("valid-claim"), false);
});

test("escapes database text and never renders an API key in usage output", async () => {
  const { bot, calls, subscriptions } = createSubject();

  await bot.handleUpdate(commandUpdate(1, "/start valid-claim") as never);
  await bot.handleUpdate(commandUpdate(2, "/usage") as never);
  await bot.handleUpdate(commandUpdate(3, "/status") as never);
  await bot.handleUpdate(commandUpdate(4, "/alerts") as never);
  await bot.handleUpdate(commandUpdate(5, "/mute") as never);
  await bot.handleUpdate(commandUpdate(6, "/unmute") as never);

  const allMessages = messages(calls);
  const usageMessage = allMessages[1] ?? "";
  assert.match(usageMessage, /&lt;Ops &amp; &quot;Key&quot;&gt;/);
  assert.match(usageMessage, /12,345/);
  assert.equal(usageMessage.includes("raw-customer-key-not-rendered"), false);
  assert.equal(usageMessage.includes('<Ops & "Key">'), false);
  assert.match(allMessages.join("\n"), /Đã kết nối\. Cảnh báo đang bật/);
  assert.match(allMessages.join("\n"), /Daily &lt;limit&gt;/);
  assert.equal(subscriptions.get("12345")?.mutedUntil, null);
});

test("mutes through a fixed callback and requires disconnect confirmation", async () => {
  const { bot, calls, subscriptions } = createSubject();

  await bot.handleUpdate(commandUpdate(1, "/start valid-claim") as never);
  await bot.handleUpdate(commandUpdate(2, "/mute") as never);
  await bot.handleUpdate(callbackUpdate(3, "mute24") as never);
  assert.ok(subscriptions.get("12345")?.mutedUntil);
  await bot.handleUpdate(commandUpdate(4, "/disconnect") as never);
  await bot.handleUpdate(callbackUpdate(5, "disconnect_cancel") as never);
  await bot.handleUpdate(callbackUpdate(6, "disconnect_confirm") as never);

  assert.equal(subscriptions.has("12345"), false);
  assert.match(messages(calls).join("\n"), /Xác nhận ngắt kết nối/);
  assert.match(messages(calls).join("\n"), /Đã ngắt kết nối/);
  assert.equal(JSON.stringify(calls).includes("disconnect_unsafe"), false);
});

test("shows help for unknown commands, throttles six commands per minute, and limits invalid claims", async () => {
  const unknown = createSubject();
  await unknown.bot.handleUpdate(commandUpdate(1, "/unknown") as never);
  assert.match(messages(unknown.calls)[0] ?? "", /\/help/);

  const throttled = createSubject();
  for (let index = 1; index <= 7; index += 1) {
    await throttled.bot.handleUpdate(commandUpdate(index, "/help") as never);
  }
  assert.equal(messages(throttled.calls).length, 6);

  const invalidClaims = createSubject();
  for (let index = 1; index <= 6; index += 1) {
    await invalidClaims.bot.handleUpdate(commandUpdate(index, "/start invalid-claim") as never);
  }
  assert.equal(messages(invalidClaims.calls).length, 5);
});
