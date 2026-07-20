import { limit } from "@grammyjs/ratelimiter";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { TelegramSubscription } from "@/lib/db/telegramBot";
import {
  escapeTelegramHtml,
  formatTelegramNumber,
  TELEGRAM_HELP_MESSAGE,
  TELEGRAM_INVALID_CLAIM_MESSAGE,
  TELEGRAM_NOT_CONNECTED_MESSAGE,
} from "./messages";

const COMMAND_LIMIT_PER_MINUTE = 6;
const INVALID_CLAIM_LIMIT = 5;
const INVALID_CLAIM_WINDOW_MS = 15 * 60 * 1000;
const MUTE_DURATION_MS = 24 * 60 * 60 * 1000;

export const TELEGRAM_CALLBACK_DATA = [
  "usage",
  "alerts",
  "mute24",
  "unmute",
  "disconnect_confirm",
  "disconnect_cancel",
] as const;

type TelegramCallbackData = (typeof TELEGRAM_CALLBACK_DATA)[number];

interface TelegramUsage {
  key: { name: string; state: string };
  tokens: { today: number; remaining: number | null; limit: number | null };
  alerts: Array<{ title: string; message: string }>;
}

export interface TelegramTokenBotDeps {
  bot: Bot;
  consumeClaim: (token: string, chatId: string) => TelegramSubscription | null;
  getSubscription: (chatId: string) => TelegramSubscription | null;
  setMute: (chatId: string, mutedUntil: Date | null) => boolean;
  disconnect: (chatId: string) => boolean;
  getUsage: (apiKeyId: string) => Promise<TelegramUsage | null>;
  now?: () => Date;
}

function privateChatId(ctx: Context): string | null {
  return ctx.chat?.type === "private" ? String(ctx.chat.id) : null;
}

function actionKeyboard() {
  return new InlineKeyboard()
    .text("Dùng", "usage")
    .text("Cảnh báo", "alerts")
    .row()
    .text("Tắt 24h", "mute24")
    .text("Bật lại", "unmute")
    .row()
    .text("Ngắt kết nối", "disconnect_confirm");
}

function disconnectKeyboard() {
  return new InlineKeyboard().text("Ngắt", "disconnect_confirm").text("Hủy", "disconnect_cancel");
}

function isCallbackData(value: string): value is TelegramCallbackData {
  return (TELEGRAM_CALLBACK_DATA as readonly string[]).includes(value);
}

function commandChatId(ctx: Context): string | undefined {
  const text = ctx.message?.text;
  const isCommand =
    typeof text === "string" &&
    text.startsWith("/") &&
    ctx.message.entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0);
  return isCommand ? (privateChatId(ctx) ?? undefined) : undefined;
}

function usageMessage(usage: TelegramUsage): string {
  const remaining =
    usage.tokens.remaining === null
      ? "Không giới hạn"
      : formatTelegramNumber(usage.tokens.remaining);
  return [
    `<b>${escapeTelegramHtml(usage.key.name)}</b>`,
    `Hôm nay: ${formatTelegramNumber(usage.tokens.today)} token`,
    `Còn lại: ${remaining}`,
  ].join("\n");
}

function alertsMessage(usage: TelegramUsage): string {
  if (usage.alerts.length === 0) return "Không có cảnh báo.";
  return usage.alerts
    .map(
      (alert) => `<b>${escapeTelegramHtml(alert.title)}</b>\n${escapeTelegramHtml(alert.message)}`
    )
    .join("\n\n");
}

export function createTelegramTokenBot(deps: TelegramTokenBotDeps): Bot {
  const invalidClaims = new Map<string, number[]>();
  const now = deps.now ?? (() => new Date());
  const reply = (ctx: Context, text: string, keyboard?: InlineKeyboard) =>
    ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  const getSubscription = (ctx: Context) => {
    const chatId = privateChatId(ctx);
    return chatId ? deps.getSubscription(chatId) : null;
  };
  const getUsage = async (ctx: Context) => {
    const subscription = getSubscription(ctx);
    return subscription ? deps.getUsage(subscription.apiKeyId) : null;
  };

  // This first gate keeps all group, channel, and inline traffic silent.
  deps.bot.use(async (ctx, next) => {
    if (!privateChatId(ctx)) return;
    await next();
  });
  deps.bot.use(
    limit({
      timeFrame: 60_000,
      limit: COMMAND_LIMIT_PER_MINUTE,
      keyGenerator: commandChatId,
    })
  );

  deps.bot.command("start", async (ctx) => {
    const chatId = privateChatId(ctx);
    if (!chatId) return;
    const attempts =
      invalidClaims
        .get(chatId)
        ?.filter((time) => now().getTime() - time < INVALID_CLAIM_WINDOW_MS) ?? [];
    const token = ctx.match.trim();
    if (!token || attempts.length >= INVALID_CLAIM_LIMIT) {
      invalidClaims.set(chatId, attempts);
      if (attempts.length < INVALID_CLAIM_LIMIT) {
        invalidClaims.set(chatId, [...attempts, now().getTime()]);
        await reply(ctx, TELEGRAM_INVALID_CLAIM_MESSAGE);
      }
      return;
    }

    const subscription = deps.consumeClaim(token, chatId);
    if (!subscription) {
      invalidClaims.set(chatId, [...attempts, now().getTime()]);
      await reply(ctx, TELEGRAM_INVALID_CLAIM_MESSAGE);
      return;
    }

    invalidClaims.delete(chatId);
    await reply(ctx, "Đã kết nối. Dùng /usage để xem mức sử dụng.", actionKeyboard());
  });

  deps.bot.command("status", async (ctx) => {
    const subscription = getSubscription(ctx);
    if (!subscription) return reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
    const muted = subscription.mutedUntil ? "đang tắt" : "đang bật";
    await reply(ctx, `Đã kết nối. Cảnh báo ${muted}.`, actionKeyboard());
  });

  deps.bot.command("usage", async (ctx) => {
    const usage = await getUsage(ctx);
    await reply(
      ctx,
      usage ? usageMessage(usage) : TELEGRAM_NOT_CONNECTED_MESSAGE,
      actionKeyboard()
    );
  });

  deps.bot.command("alerts", async (ctx) => {
    const usage = await getUsage(ctx);
    await reply(
      ctx,
      usage ? alertsMessage(usage) : TELEGRAM_NOT_CONNECTED_MESSAGE,
      actionKeyboard()
    );
  });

  deps.bot.command("mute", async (ctx) => {
    const chatId = privateChatId(ctx);
    if (!chatId || !deps.setMute(chatId, new Date(now().getTime() + MUTE_DURATION_MS))) {
      return reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
    }
    await reply(ctx, "Đã tắt cảnh báo 24 giờ.", actionKeyboard());
  });

  deps.bot.command("unmute", async (ctx) => {
    const chatId = privateChatId(ctx);
    if (!chatId || !deps.setMute(chatId, null)) return reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
    await reply(ctx, "Đã bật lại cảnh báo.", actionKeyboard());
  });

  deps.bot.command("disconnect", async (ctx) => {
    if (!getSubscription(ctx)) return reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
    await reply(ctx, "Xác nhận ngắt kết nối?", disconnectKeyboard());
  });

  deps.bot.command("help", (ctx) => reply(ctx, TELEGRAM_HELP_MESSAGE, actionKeyboard()));

  deps.bot.on("callback_query:data", async (ctx) => {
    const chatId = privateChatId(ctx);
    const data = ctx.callbackQuery.data;
    if (!chatId || !isCallbackData(data)) return;
    await ctx.answerCallbackQuery();

    if (data === "usage") {
      const usage = await getUsage(ctx);
      await reply(
        ctx,
        usage ? usageMessage(usage) : TELEGRAM_NOT_CONNECTED_MESSAGE,
        actionKeyboard()
      );
      return;
    }
    if (data === "alerts") {
      const usage = await getUsage(ctx);
      await reply(
        ctx,
        usage ? alertsMessage(usage) : TELEGRAM_NOT_CONNECTED_MESSAGE,
        actionKeyboard()
      );
      return;
    }
    if (data === "mute24") {
      const muted = deps.setMute(chatId, new Date(now().getTime() + MUTE_DURATION_MS));
      await reply(
        ctx,
        muted ? "Đã tắt cảnh báo 24 giờ." : TELEGRAM_NOT_CONNECTED_MESSAGE,
        actionKeyboard()
      );
      return;
    }
    if (data === "unmute") {
      const unmuted = deps.setMute(chatId, null);
      await reply(
        ctx,
        unmuted ? "Đã bật lại cảnh báo." : TELEGRAM_NOT_CONNECTED_MESSAGE,
        actionKeyboard()
      );
      return;
    }
    if (data === "disconnect_cancel") {
      await reply(ctx, "Đã giữ kết nối.", actionKeyboard());
      return;
    }
    const disconnected = deps.disconnect(chatId);
    await reply(ctx, disconnected ? "Đã ngắt kết nối." : TELEGRAM_NOT_CONNECTED_MESSAGE);
  });

  deps.bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) await reply(ctx, TELEGRAM_HELP_MESSAGE, actionKeyboard());
  });

  return deps.bot;
}
