import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import type { ApiKeyCustomerUsage } from "../../src/lib/usage/apiKeyCustomerUsage.ts";
import type { ApiKeyRequestLogPage } from "../../src/lib/usage/apiKeyRequestLogs.ts";
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

function textUpdate(updateId: number, text: string, chatType: "private" | "group" = "private") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: 12345, type: chatType },
      from: { id: 999, is_bot: false, first_name: "Customer" },
      text,
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

function usageFixture(modelCount = 2): ApiKeyCustomerUsage {
  const models = Array.from({ length: modelCount }, (_, index) => ({
    model: index === 0 ? '<gpt & "primary">' : `model-${String(index + 1).padStart(3, "0")}`,
    requests: 100 - Math.min(index, 99),
    input_tokens: 10_000 - Math.min(index, 9_000),
    output_tokens: 5_000 - Math.min(index, 4_000),
    total_tokens: 15_000 - Math.min(index, 13_000),
    last_used_at: "2026-07-20T02:30:00.000Z",
  }));

  return {
    success: true,
    checkedAt: "2026-07-20T03:00:00.000Z",
    object: "api_key_usage",
    key: {
      name: '<Ops & "Key">',
      prefix: "qrouter_****mask",
      state: "active",
      expires_at: "2026-08-20T00:00:00.000Z",
    },
    requests: {
      today: 120,
      hour: 12,
      total: 4_200,
      limit: 1_000,
      remaining: 880,
      reset_at: "2026-07-21T00:00:00.000Z",
    },
    tokens: {
      today: 12_345,
      hour: 1_234,
      total: 234_567,
      input: 180_000,
      output: 54_567,
      limit: 1_000_000,
      remaining: 765_433,
      daily_limit: 100_000,
      daily_remaining: 87_655,
      hourly_limit: 10_000,
      hourly_remaining: 8_766,
      reset_at: "2026-07-21T00:00:00.000Z",
    },
    usage: {
      all: {
        requests: 4_200,
        promptGptTokens: 180_000,
        completionGptTokens: 54_567,
        totalGptTokens: 234_567,
      },
      today: {
        requests: 120,
        promptGptTokens: 0,
        completionGptTokens: 0,
        totalGptTokens: 12_345,
      },
      lastHour: { requests: 12, totalGptTokens: 1_234 },
      byModel: models,
    },
    quotaUsage: {
      totalTokenUsed: 234_567,
      lifetimeTokenUsed: 234_567,
      dailyTokenUsed: 12_000,
      dailyReservedTokens: 345,
      hourlyTokenUsed: 1_200,
      hourlyReservedTokens: 34,
    },
    requestQuota: {
      limit: 1_000,
      used: 120,
      remaining: 880,
      resetAt: "2026-07-21T00:00:00.000Z",
    },
    tokenQuota: {
      limit: 100_000,
      used: 12_000,
      reserved: 345,
      effectiveUsed: 12_345,
      remaining: 87_655,
      resetAt: "2026-07-21T00:00:00.000Z",
    },
    alerts: [
      {
        id: "daily_tokens:90",
        metric: "daily_tokens",
        level: "warning",
        thresholdPercent: 90,
        usedPercent: 92,
        title: "Daily <limit>",
        message: "90% & rising",
        resetAt: "2026-07-21T00:00:00.000Z",
      },
    ],
    models,
  };
}

function requestLogPage(requestedPage: number, total = 23): ApiKeyRequestLogPage {
  const totalPages = Math.max(1, Math.ceil(total / 10));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const offset = (page - 1) * 10;
  const logs = Array.from({ length: Math.min(10, Math.max(0, total - offset)) }, (_, index) => {
    const position = offset + index;
    return {
      id: `request-${position}`,
      timestamp: `2026-07-20T02:${String(59 - position).padStart(2, "0")}:00.000Z`,
      method: "POST",
      path: "/v1/chat/completions",
      status: position === 1 ? 429 : 200,
      outcome: position === 1 ? ("error" as const) : ("success" as const),
      model: position === 0 ? "<gpt & primary>" : `gpt-page-${page}-${index + 1}`,
      requestedModel: null,
      requestType: "chat",
      durationMs: 800 + position,
      tokens: {
        input: 100 + position,
        output: 20,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
        total: 120 + position,
      },
      cacheSource: "upstream",
      sourceFormat: "openai",
      targetFormat: "responses",
      error: position === 1 ? "Rate <limit> & retry" : null,
    };
  });
  return {
    logs,
    page,
    pageSize: 10,
    total,
    totalPages,
    summary: {
      returned: logs.length,
      errors: logs.filter((log) => log.outcome === "error").length,
      averageLatencyMs:
        logs.length === 0
          ? null
          : Math.round(logs.reduce((sum, log) => sum + log.durationMs, 0) / logs.length),
    },
  };
}

function createSubject(options: { modelCount?: number; logTotal?: number } = {}) {
  const fakeTelegram = createFakeTelegramApi();
  const subscriptions = new Map<string, { apiKeyId: string; mutedUntil: string | null }>();
  const directApiKey = "qrouter_sk_abcdefghijklmnopqrstuvwxyz123456";
  const bot = new Bot("telegram-test-token", { client: { fetch: fakeTelegram.fetch } });
  bot.botInfo = { id: 1, is_bot: true, first_name: "QRouter", username: "qrouter_token_bot" };
  const usage = usageFixture(options.modelCount);
  const usageLookups: string[] = [];
  const logPageLookups: Array<{ apiKeyId: string; page: number }> = [];
  let currentTime = new Date("2026-07-20T03:00:00.000Z");

  const connect = (chatId: string) => {
    const subscription = subscriptions.get(chatId) ?? {
      apiKeyId: "api-key-id",
      mutedUntil: "2026-07-21T00:00:00.000Z",
    };
    subscriptions.set(chatId, subscription);
    return { id: "subscription-id", chatId, ...subscription, createdAt: "", updatedAt: "" };
  };

  createTelegramTokenBot({
    bot,
    connectToken: async (token, chatId) => (token === directApiKey ? connect(chatId) : null),
    consumeClaim: (token, chatId) => (token === "valid-claim" ? connect(chatId) : null),
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
    getUsage: async (apiKeyId) => {
      usageLookups.push(apiKeyId);
      return usage;
    },
    getRequestLogPage: async (apiKeyId, page) => {
      logPageLookups.push({ apiKeyId, page });
      return requestLogPage(page, options.logTotal ?? 23);
    },
    now: () => currentTime,
  });

  return {
    bot,
    calls: fakeTelegram.calls,
    directApiKey,
    subscriptions,
    usage,
    usageLookups,
    logPageLookups,
    setNow: (value: string) => {
      currentTime = new Date(value);
    },
  };
}

function callsFor(calls: FakeTelegramCall[], method: string) {
  return calls.filter((call) => call.method === method);
}

function messages(calls: FakeTelegramCall[]) {
  return callsFor(calls, "sendMessage").map((call) => String(call.payload.text));
}

function inlineButtons(payload: Record<string, unknown>) {
  const keyboard = payload.reply_markup as
    | { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> }
    | undefined;
  return keyboard?.inline_keyboard?.flat() ?? [];
}

test("plain start gives one direct API-key instruction without the legacy command menu", async () => {
  const { bot, calls } = createSubject();

  await bot.handleUpdate(commandUpdate(1, "/start") as never);

  assert.equal(messages(calls).length, 1);
  assert.match(messages(calls)[0] ?? "", /QRouter Usage/);
  assert.match(messages(calls)[0] ?? "", /gửi API key/i);
  assert.doesNotMatch(messages(calls)[0] ?? "", /\/usage|\/alerts|\/mute|\/disconnect/i);
  assert.equal(inlineButtons(callsFor(calls, "sendMessage")[0]?.payload ?? {}).length, 0);
});

test("submitted key is deleted, enables alerts, and returns a compact dashboard", async () => {
  const { bot, calls, directApiKey, subscriptions } = createSubject();

  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  assert.equal(subscriptions.get("12345")?.mutedUntil, null);
  assert.equal(callsFor(calls, "deleteMessage").length, 1);
  assert.equal(JSON.stringify(calls).includes(directApiKey), false);

  const sent = callsFor(calls, "sendMessage")[0];
  const message = String(sent?.payload.text ?? "");
  assert.match(message, /🟢.*QROUTER KEY/s);
  assert.match(message, /qrouter_\*\*\*\*mask/);
  assert.match(message, /📊.*HÔM NAY/s);
  assert.match(message, /⚡.*1 GIỜ QUA/s);
  assert.match(message, /📦.*TỔNG SỬ DỤNG/s);
  assert.match(message, /12\.3K/);
  assert.match(message, /87\.7K token · 880 yêu cầu/);
  assert.match(message, /234\.6K/);
  assert.match(message, /Hết hạn/);
  assert.doesNotMatch(message, /Model sử dụng|Quota giờ|Đã giữ chỗ|Input:|Output:/);
  assert.equal(message.length < 1_500, true);

  assert.deepEqual(inlineButtons(sent?.payload ?? {}), [
    { text: "🔄 Làm mới", callback_data: "refresh_dashboard" },
    { text: "📜 Xem log", callback_data: "show_logs:1" },
    { text: "🔕 Tắt cảnh báo", callback_data: "toggle_alerts" },
  ]);
});

test("alert toggle preserves dashboard actions and edits its keyboard without chat clutter", async () => {
  const { bot, calls, directApiKey, subscriptions, setNow } = createSubject();
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);
  const sentCount = callsFor(calls, "sendMessage").length;

  await bot.handleUpdate(callbackUpdate(2, "toggle_alerts") as never);

  assert.equal(subscriptions.get("12345")?.mutedUntil, "9999-12-31T23:59:59.999Z");
  assert.equal(callsFor(calls, "sendMessage").length, sentCount);
  const firstEdit = callsFor(calls, "editMessageReplyMarkup").at(-1);
  assert.deepEqual(inlineButtons(firstEdit?.payload ?? {}), [
    { text: "🔄 Làm mới", callback_data: "refresh_dashboard" },
    { text: "📜 Xem log", callback_data: "show_logs:1" },
    { text: "🔔 Bật cảnh báo", callback_data: "toggle_alerts" },
  ]);

  setNow("2026-07-20T03:00:04.000Z");
  await bot.handleUpdate(callbackUpdate(3, "toggle_alerts") as never);
  assert.equal(subscriptions.get("12345")?.mutedUntil, null);
  const secondEdit = callsFor(calls, "editMessageReplyMarkup").at(-1);
  assert.deepEqual(inlineButtons(secondEdit?.payload ?? {}), [
    { text: "🔄 Làm mới", callback_data: "refresh_dashboard" },
    { text: "📜 Xem log", callback_data: "show_logs:1" },
    { text: "🔕 Tắt cảnh báo", callback_data: "toggle_alerts" },
  ]);
});

test("dashboard escapes database text and remains compact with many models", async () => {
  const { bot, calls, directApiKey } = createSubject({ modelCount: 120 });

  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  const message = messages(calls)[0] ?? "";
  assert.equal(message.length < 1_500, true);
  assert.match(message, /&lt;Ops &amp; &quot;Key&quot;&gt;/);
  assert.doesNotMatch(message, /<Ops & "Key">|model-120|model khác|Model sử dụng/);
});

test("check command reloads the linked key without receiving the raw key again", async () => {
  const { bot, calls, directApiKey, usageLookups, setNow } = createSubject();
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  setNow("2026-07-20T03:00:04.000Z");
  await bot.handleUpdate(commandUpdate(2, "/check") as never);

  assert.deepEqual(usageLookups, ["api-key-id", "api-key-id"]);
  assert.equal(messages(calls).length, 2);
  assert.match(messages(calls)[1] ?? "", /QROUTER KEY/);
  assert.equal(JSON.stringify(calls).includes(directApiKey), false);
});

test("request logs show ten rows per page and navigate in the same message", async () => {
  const { bot, calls, directApiKey, logPageLookups, setNow } = createSubject();
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  setNow("2026-07-20T03:00:04.000Z");
  await bot.handleUpdate(callbackUpdate(2, "show_logs:1") as never);
  const firstEdit = callsFor(calls, "editMessageText").at(-1);
  const firstText = String(firstEdit?.payload.text ?? "");
  assert.deepEqual(logPageLookups, [{ apiKeyId: "api-key-id", page: 1 }]);
  assert.match(firstText, /NHẬT KÝ GẦN ĐÂY/);
  assert.match(firstText, /Trang 1\/3 · 10 request/);
  assert.match(firstText, /Cập nhật: 10:00 20\/7\/26/);
  assert.equal((firstText.match(/gpt-page-|&lt;gpt/g) ?? []).length, 10);
  assert.match(firstText, /&lt;gpt &amp; primary&gt;/);
  assert.match(firstText, /Rate &lt;limit&gt; &amp; retry/);
  assert.deepEqual(inlineButtons(firstEdit?.payload ?? {}), [
    { text: "1/3", callback_data: "noop" },
    { text: "Sau ➡️", callback_data: "show_logs:2" },
    { text: "🏠 Tổng quan", callback_data: "show_dashboard" },
    { text: "🔄 Làm mới", callback_data: "refresh_logs:1" },
  ]);

  setNow("2026-07-20T03:00:08.000Z");
  await bot.handleUpdate(callbackUpdate(3, "show_logs:2") as never);
  const secondEdit = callsFor(calls, "editMessageText").at(-1);
  assert.match(String(secondEdit?.payload.text ?? ""), /Trang 2\/3 · 10 request/);
  assert.deepEqual(inlineButtons(secondEdit?.payload ?? {}), [
    { text: "⬅️ Trước", callback_data: "show_logs:1" },
    { text: "2/3", callback_data: "noop" },
    { text: "Sau ➡️", callback_data: "show_logs:3" },
    { text: "🏠 Tổng quan", callback_data: "show_dashboard" },
    { text: "🔄 Làm mới", callback_data: "refresh_logs:2" },
  ]);

  setNow("2026-07-20T03:00:12.000Z");
  await bot.handleUpdate(callbackUpdate(4, "show_dashboard") as never);
  const dashboardEdit = callsFor(calls, "editMessageText").at(-1);
  assert.match(String(dashboardEdit?.payload.text ?? ""), /QROUTER KEY/);
  assert.equal(callsFor(calls, "sendMessage").length, 1);
});

test("empty request logs keep a bounded one-page view", async () => {
  const { bot, calls, directApiKey, setNow } = createSubject({ logTotal: 0 });
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);
  setNow("2026-07-20T03:00:04.000Z");
  await bot.handleUpdate(callbackUpdate(2, "show_logs:1") as never);

  const edit = callsFor(calls, "editMessageText").at(-1);
  assert.match(String(edit?.payload.text ?? ""), /Chưa có request nào/);
  assert.deepEqual(inlineButtons(edit?.payload ?? {}), [
    { text: "1/1", callback_data: "noop" },
    { text: "🏠 Tổng quan", callback_data: "show_dashboard" },
    { text: "🔄 Làm mới", callback_data: "refresh_logs:1" },
  ]);
});

test("dashboard callbacks enforce a three-second cooldown without extra queries", async () => {
  const { bot, calls, directApiKey, usageLookups, setNow } = createSubject();
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  setNow("2026-07-20T03:00:04.000Z");
  await bot.handleUpdate(callbackUpdate(2, "refresh_dashboard") as never);
  setNow("2026-07-20T03:00:05.000Z");
  await bot.handleUpdate(callbackUpdate(3, "refresh_dashboard") as never);

  assert.equal(usageLookups.length, 2);
  assert.equal(callsFor(calls, "editMessageText").length, 1);
  assert.equal(
    callsFor(calls, "answerCallbackQuery").some(
      (call) => call.payload.text === "Vui lòng chờ một chút."
    ),
    true
  );
});

test("callback actions stop after ten operations in a rolling minute", async () => {
  const { bot, calls, directApiKey, usageLookups, setNow } = createSubject();
  await bot.handleUpdate(textUpdate(1, directApiKey) as never);

  for (let index = 0; index < 11; index += 1) {
    setNow(`2026-07-20T03:00:${String(4 + index * 4).padStart(2, "0")}.000Z`);
    await bot.handleUpdate(callbackUpdate(index + 2, "refresh_dashboard") as never);
  }

  assert.equal(usageLookups.length, 11);
  assert.equal(callsFor(calls, "editMessageText").length, 10);
  assert.equal(
    callsFor(calls, "answerCallbackQuery").at(-1)?.payload.text,
    "Vui lòng chờ một chút."
  );
});

test("legacy claims stay private and invalid credentials use one generic response", async () => {
  const { bot, calls, subscriptions } = createSubject();

  await bot.handleUpdate(commandUpdate(1, "/start valid-claim") as never);
  await bot.handleUpdate(commandUpdate(2, "/start valid-claim", "group") as never);
  await bot.handleUpdate(commandUpdate(3, "/start invalid-claim") as never);

  assert.equal(subscriptions.has("12345"), true);
  assert.equal(messages(calls).length, 2);
  assert.equal(messages(calls)[1], "API key không hợp lệ, đã hết hạn hoặc đã bị vô hiệu hóa.");
  assert.equal(JSON.stringify(calls).includes("valid-claim"), false);
});

test("unknown commands stay minimal while command and invalid-key limits remain enforced", async () => {
  const unknown = createSubject();
  await unknown.bot.handleUpdate(commandUpdate(1, "/unknown") as never);
  assert.match(messages(unknown.calls)[0] ?? "", /gửi API key/i);
  assert.doesNotMatch(messages(unknown.calls)[0] ?? "", /\/usage|\/help/i);

  const throttled = createSubject();
  for (let index = 1; index <= 7; index += 1) {
    await throttled.bot.handleUpdate(commandUpdate(index, "/start") as never);
  }
  assert.equal(messages(throttled.calls).length, 6);

  const invalidCredentials = createSubject();
  for (let index = 1; index <= 6; index += 1) {
    await invalidCredentials.bot.handleUpdate(commandUpdate(index, "/start invalid-key") as never);
  }
  assert.equal(messages(invalidCredentials.calls).length, 5);
});
