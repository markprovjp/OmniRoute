import { limit } from "@grammyjs/ratelimiter";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { TelegramSubscription } from "@/lib/db/telegramBot";
import type { ApiKeyCustomerUsage } from "@/lib/usage/apiKeyCustomerUsage";
import type { ApiKeyRequestLogPage } from "@/lib/usage/apiKeyRequestLogs";
import {
  escapeTelegramHtml,
  formatTelegramNumber,
  TELEGRAM_INVALID_CLAIM_MESSAGE,
  TELEGRAM_NOT_CONNECTED_MESSAGE,
  TELEGRAM_WELCOME_MESSAGE,
} from "./messages";

const COMMAND_LIMIT_PER_MINUTE = 6;
const INVALID_CREDENTIAL_LIMIT = 5;
const INVALID_CREDENTIAL_WINDOW_MS = 15 * 60 * 1000;
const ACTION_COOLDOWN_MS = 3_000;
const ACTION_LIMIT_PER_MINUTE = 10;
const ACTION_WINDOW_MS = 60_000;
const MAX_ACTION_TRACKERS = 10_000;
const ALERTS_DISABLED_UNTIL = new Date("9999-12-31T23:59:59.999Z");
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const LOG_ERROR_MAX_LENGTH = 120;

export const TELEGRAM_CALLBACK_DATA = [
  "refresh_dashboard",
  "show_dashboard",
  "show_logs:<page>",
  "refresh_logs:<page>",
  "toggle_alerts",
  "noop",
] as const;

export interface TelegramTokenBotDeps {
  bot: Bot;
  connectToken: (token: string, chatId: string) => Promise<TelegramSubscription | null>;
  consumeClaim?: (token: string, chatId: string) => TelegramSubscription | null;
  getSubscription: (chatId: string) => TelegramSubscription | null;
  setMute: (chatId: string, mutedUntil: Date | null) => boolean;
  getUsage: (apiKeyId: string) => Promise<ApiKeyCustomerUsage | null>;
  getRequestLogPage: (apiKeyId: string, page: number) => Promise<ApiKeyRequestLogPage>;
  now?: () => Date;
}

type ActionTracker = {
  lastAcceptedAt: number;
  acceptedAt: number[];
};

function privateChatId(ctx: Context): string | null {
  return ctx.chat?.type === "private" ? String(ctx.chat.id) : null;
}

function commandChatId(ctx: Context): string | undefined {
  const text = ctx.message?.text;
  const isCommand =
    typeof text === "string" &&
    text.startsWith("/") &&
    ctx.message.entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0);
  return isCommand ? (privateChatId(ctx) ?? undefined) : undefined;
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeText(value: unknown, maxLength: number): string {
  return escapeTelegramHtml(truncate(value, maxLength));
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Không có";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Không có";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "-";
  const amount = value ?? 0;
  const absolute = Math.abs(amount);
  const units = [
    { threshold: 1_000_000_000_000, suffix: "T" },
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" },
  ];
  const unit = units.find((candidate) => absolute >= candidate.threshold);
  if (!unit) return formatTelegramNumber(amount);
  const scaled = amount / unit.threshold;
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
}

function statePresentation(state: ApiKeyCustomerUsage["key"]["state"]): {
  icon: string;
  label: string;
} {
  if (state === "active") return { icon: "🟢", label: "Đang hoạt động" };
  if (state === "expired") return { icon: "🔴", label: "Đã hết hạn" };
  if (state === "banned") return { icon: "🔴", label: "Đã bị khóa" };
  return { icon: "🟠", label: "Đã tắt" };
}

function alertsEnabled(subscription: TelegramSubscription, now: Date): boolean {
  if (!subscription.mutedUntil) return true;
  const mutedUntil = new Date(subscription.mutedUntil).getTime();
  return !Number.isFinite(mutedUntil) || mutedUntil <= now.getTime();
}

function dashboardKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Làm mới", "refresh_dashboard")
    .text("📜 Xem log", "show_logs:1")
    .row()
    .text(enabled ? "🔕 Tắt cảnh báo" : "🔔 Bật cảnh báo", "toggle_alerts");
}

function logKeyboard(page: ApiKeyRequestLogPage): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page.page > 1) keyboard.text("⬅️ Trước", `show_logs:${page.page - 1}`);
  keyboard.text(`${page.page}/${page.totalPages}`, "noop");
  if (page.page < page.totalPages) keyboard.text("Sau ➡️", `show_logs:${page.page + 1}`);
  return keyboard
    .row()
    .text("🏠 Tổng quan", "show_dashboard")
    .text("🔄 Làm mới", `refresh_logs:${page.page}`);
}

function remainingToday(usage: ApiKeyCustomerUsage): string {
  const remaining = [];
  if (usage.tokenQuota.remaining !== null) {
    remaining.push(`${formatCompactNumber(usage.tokenQuota.remaining)} token`);
  }
  if (usage.requestQuota.remaining !== null) {
    remaining.push(`${formatCompactNumber(usage.requestQuota.remaining)} yêu cầu`);
  }
  return remaining.length > 0 ? remaining.join(" · ") : "Không giới hạn";
}

function dashboardMessage(usage: ApiKeyCustomerUsage): string {
  const state = statePresentation(usage.key.state);
  const alertSummary =
    usage.alerts.length === 0
      ? "✅ Không có cảnh báo"
      : `⚠️ <b>${formatTelegramNumber(usage.alerts.length)} cảnh báo</b> · ${safeText(usage.alerts[0]?.title, 100)}`;

  const message = [
    `${state.icon} <b>QROUTER KEY</b>`,
    `<b>${safeText(usage.key.name, 100)}</b> · <code>${safeText(usage.key.prefix ?? "-", 80)}</code>`,
    `${state.label} · Hết hạn ${formatDate(usage.key.expires_at)}`,
    "",
    "📊 <b>HÔM NAY</b>",
    `<code>${formatCompactNumber(usage.tokenQuota.effectiveUsed)}</code> token · <code>${formatCompactNumber(usage.requests.today)}</code> yêu cầu`,
    `Còn lại: ${remainingToday(usage)}`,
    `Reset: ${formatDate(usage.tokenQuota.resetAt ?? usage.requests.reset_at)}`,
    "",
    "⚡ <b>1 GIỜ QUA</b>",
    `<code>${formatCompactNumber(usage.quotaUsage.hourlyTokenUsed + usage.quotaUsage.hourlyReservedTokens)}</code> token · <code>${formatCompactNumber(usage.requests.hour)}</code> yêu cầu`,
    "",
    "📦 <b>TỔNG SỬ DỤNG</b>",
    `<code>${formatCompactNumber(usage.tokens.total)}</code> token · <code>${formatCompactNumber(usage.requests.total)}</code> yêu cầu`,
    "",
    alertSummary,
    `Cập nhật: ${formatDate(usage.checkedAt)}`,
  ].join("\n");

  return message.slice(0, TELEGRAM_MESSAGE_LIMIT);
}

function formatLatency(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "-";
  return durationMs >= 1_000
    ? `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`
    : `${Math.round(durationMs)}ms`;
}

function requestLogMessage(page: ApiKeyRequestLogPage, checkedAt: Date): string {
  const lines = [
    "📜 <b>NHẬT KÝ GẦN ĐÂY</b>",
    `Trang ${page.page}/${page.totalPages} · ${formatTelegramNumber(page.logs.length)} request`,
    `Tổng ${formatTelegramNumber(page.total)} · ${formatTelegramNumber(page.summary.errors)} lỗi · TB ${formatLatency(page.summary.averageLatencyMs ?? 0)}`,
    `Cập nhật: ${formatDate(checkedAt.toISOString())}`,
  ];

  if (page.logs.length === 0) {
    lines.push("", "Chưa có request nào cho key này.");
  } else {
    for (const [index, log] of page.logs.entries()) {
      const icon = log.outcome === "success" ? "✅" : "❌";
      lines.push(
        "",
        `${page.pageSize * (page.page - 1) + index + 1}. ${icon} <b>${formatTime(log.timestamp)} · ${safeText(log.model, 90)}</b>`,
        `   ${formatTelegramNumber(log.status)} · ${formatLatency(log.durationMs)} · ${formatCompactNumber(log.tokens.total)} token`
      );
      if (log.error) lines.push(`   ${safeText(log.error, LOG_ERROR_MAX_LENGTH)}`);
    }
  }

  return lines.join("\n").slice(0, TELEGRAM_MESSAGE_LIMIT);
}

function parsePageAction(data: string, action: "show_logs" | "refresh_logs"): number | null {
  const match = new RegExp(`^${action}:(\\d{1,6})$`).exec(data);
  if (!match) return null;
  return Math.max(1, Number(match[1]));
}

export function createTelegramTokenBot(deps: TelegramTokenBotDeps): Bot {
  const invalidCredentials = new Map<string, number[]>();
  const actionTrackers = new Map<string, ActionTracker>();
  const now = deps.now ?? (() => new Date());
  const reply = (ctx: Context, text: string, keyboard?: InlineKeyboard) =>
    ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  const edit = (ctx: Context, text: string, keyboard: InlineKeyboard) =>
    ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  const deleteSensitiveMessage = async (ctx: Context) => {
    try {
      await ctx.deleteMessage();
    } catch {
      // Deletion is best-effort. The credential is never copied to logs or replies.
    }
  };
  const allowAction = (chatId: string) => {
    const current = now().getTime();
    const previous = actionTrackers.get(chatId);
    const acceptedAt =
      previous?.acceptedAt.filter((time) => current - time < ACTION_WINDOW_MS) ?? [];
    if (
      (previous && current - previous.lastAcceptedAt < ACTION_COOLDOWN_MS) ||
      acceptedAt.length >= ACTION_LIMIT_PER_MINUTE
    ) {
      actionTrackers.set(chatId, {
        lastAcceptedAt: previous?.lastAcceptedAt ?? 0,
        acceptedAt,
      });
      return false;
    }
    actionTrackers.set(chatId, { lastAcceptedAt: current, acceptedAt: [...acceptedAt, current] });
    if (actionTrackers.size > MAX_ACTION_TRACKERS) {
      const oldest = actionTrackers.keys().next().value;
      if (oldest) actionTrackers.delete(oldest);
    }
    return true;
  };

  const getLinkedSubscription = (ctx: Context) => {
    const chatId = privateChatId(ctx);
    return chatId ? deps.getSubscription(chatId) : null;
  };

  const sendDashboard = async (ctx: Context, subscription: TelegramSubscription) => {
    const usage = await deps.getUsage(subscription.apiKeyId);
    if (!usage) {
      await reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
      return;
    }
    await reply(
      ctx,
      dashboardMessage(usage),
      dashboardKeyboard(alertsEnabled(subscription, now()))
    );
  };

  const editDashboard = async (ctx: Context, subscription: TelegramSubscription) => {
    const usage = await deps.getUsage(subscription.apiKeyId);
    if (!usage) {
      await ctx.answerCallbackQuery({ text: TELEGRAM_NOT_CONNECTED_MESSAGE });
      return;
    }
    await ctx.answerCallbackQuery();
    await edit(ctx, dashboardMessage(usage), dashboardKeyboard(alertsEnabled(subscription, now())));
  };

  const editLogs = async (ctx: Context, subscription: TelegramSubscription, page: number) => {
    const result = await deps.getRequestLogPage(subscription.apiKeyId, page);
    await ctx.answerCallbackQuery();
    await edit(ctx, requestLogMessage(result, now()), logKeyboard(result));
  };

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

  const connectCredential = async (ctx: Context, token: string) => {
    const chatId = privateChatId(ctx);
    if (!chatId) return;
    const attempts =
      invalidCredentials
        .get(chatId)
        ?.filter((time) => now().getTime() - time < INVALID_CREDENTIAL_WINDOW_MS) ?? [];
    if (attempts.length >= INVALID_CREDENTIAL_LIMIT) {
      invalidCredentials.set(chatId, attempts);
      return;
    }

    await deleteSensitiveMessage(ctx);
    const directSubscription = await deps.connectToken(token, chatId);
    const subscription = directSubscription ?? deps.consumeClaim?.(token, chatId) ?? null;
    if (!subscription) {
      invalidCredentials.set(chatId, [...attempts, now().getTime()]);
      await reply(ctx, TELEGRAM_INVALID_CLAIM_MESSAGE);
      return;
    }

    invalidCredentials.delete(chatId);
    if (!deps.setMute(chatId, null)) {
      await reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
      return;
    }
    const enabledSubscription = deps.getSubscription(chatId) ?? {
      ...subscription,
      mutedUntil: null,
    };
    await sendDashboard(ctx, enabledSubscription);
  };

  deps.bot.command("start", async (ctx) => {
    const token = ctx.match.trim();
    if (!token) {
      await reply(ctx, TELEGRAM_WELCOME_MESSAGE);
      return;
    }
    await connectCredential(ctx, token);
  });

  deps.bot.command("check", async (ctx) => {
    const chatId = privateChatId(ctx);
    if (!chatId || !allowAction(chatId)) return;
    const subscription = getLinkedSubscription(ctx);
    if (!subscription) {
      await reply(ctx, TELEGRAM_NOT_CONNECTED_MESSAGE);
      return;
    }
    await sendDashboard(ctx, subscription);
  });

  deps.bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === "noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = privateChatId(ctx);
    if (!chatId) return;
    if (!allowAction(chatId)) {
      await ctx.answerCallbackQuery({ text: "Vui lòng chờ một chút." });
      return;
    }
    const subscription = getLinkedSubscription(ctx);
    if (!subscription) {
      await ctx.answerCallbackQuery({ text: TELEGRAM_NOT_CONNECTED_MESSAGE });
      return;
    }

    if (data === "refresh_dashboard" || data === "show_dashboard") {
      await editDashboard(ctx, subscription);
      return;
    }

    const showPage = parsePageAction(data, "show_logs");
    if (showPage !== null) {
      await editLogs(ctx, subscription, showPage);
      return;
    }
    const refreshPage = parsePageAction(data, "refresh_logs");
    if (refreshPage !== null) {
      await editLogs(ctx, subscription, refreshPage);
      return;
    }

    if (data !== "toggle_alerts") {
      await ctx.answerCallbackQuery();
      return;
    }
    const enabled = alertsEnabled(subscription, now());
    const nextEnabled = !enabled;
    const changed = deps.setMute(chatId, nextEnabled ? null : ALERTS_DISABLED_UNTIL);
    if (!changed) {
      await ctx.answerCallbackQuery({ text: TELEGRAM_NOT_CONNECTED_MESSAGE });
      return;
    }

    await ctx.answerCallbackQuery({
      text: nextEnabled ? "Đã bật cảnh báo." : "Đã tắt cảnh báo.",
    });
    await ctx.editMessageReplyMarkup({ reply_markup: dashboardKeyboard(nextEnabled) });
  });

  deps.bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      await reply(ctx, TELEGRAM_WELCOME_MESSAGE);
      return;
    }
    if (!text || text.length > 256 || /\s/.test(text)) {
      await reply(ctx, TELEGRAM_INVALID_CLAIM_MESSAGE);
      return;
    }
    await connectCredential(ctx, text);
  });

  return deps.bot;
}
