import { randomUUID } from "node:crypto";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot } from "grammy";
import {
  acquireTelegramBotLease,
  claimTelegramAlertDelivery,
  consumeTelegramLinkClaim,
  disconnectTelegramSubscription,
  getTelegramLastProcessedUpdateId,
  getTelegramSubscriptionByChat,
  listActiveTelegramSubscriptions,
  recordTelegramAlertDelivery,
  releaseTelegramBotLease,
  renewTelegramBotLease,
  setTelegramLastProcessedUpdateId,
  setTelegramMute,
} from "@/lib/db/telegramBot";
import { getApiKeyCustomerUsageById } from "@/lib/usage/apiKeyCustomerUsage";
import {
  startTelegramAlertMonitor,
  type TelegramAlertMonitor,
  type TelegramAlertMonitorDeps,
} from "./alertMonitor";
import { createTelegramTokenBot, type TelegramTokenBotDeps } from "./bot";

const DEFAULT_TELEGRAM_BOT_USERNAME = "qrouter_token_bot";
const LEASE_MS = 60_000;
const LEASE_RENEWAL_MS = LEASE_MS / 2;

export interface TelegramTokenBotRuntime {
  bot: Bot;
  stop: () => Promise<void>;
}

export interface StartTelegramTokenBotOptions {
  bot?: Bot;
  deps?: Partial<Omit<TelegramTokenBotDeps, "bot">>;
  env?: NodeJS.ProcessEnv;
  ownerId?: string;
  runBot?: typeof run;
  startMonitor?: (deps: TelegramAlertMonitorDeps, intervalMs: number) => TelegramAlertMonitor;
  registerSignalHandlers?: boolean;
}

function requiredToken(env: NodeJS.ProcessEnv): string {
  const token = env.QROUTER_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("QROUTER_TELEGRAM_BOT_TOKEN is required");
  return token;
}

function expectedUsername(env: NodeJS.ProcessEnv): string {
  const configured = env.QROUTER_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return (configured || DEFAULT_TELEGRAM_BOT_USERNAME).toLowerCase();
}

function allowsWebhookDeletion(env: NodeJS.ProcessEnv): boolean {
  return env.QROUTER_TELEGRAM_ALLOW_DELETE_WEBHOOK === "true";
}

export async function startTelegramTokenBot(
  options: StartTelegramTokenBotOptions = {}
): Promise<TelegramTokenBotRuntime> {
  const env = options.env ?? process.env;
  const token = requiredToken(env);
  const bot = options.bot ?? new Bot(token);
  const ownerId = options.ownerId ?? randomUUID();
  const runBot = options.runBot ?? run;
  const startMonitor = options.startMonitor ?? startTelegramAlertMonitor;
  let runner: RunnerHandle | null = null;
  let alertMonitor: TelegramAlertMonitor | null = null;
  let releaseLease = false;
  let renewalTimer: NodeJS.Timeout | null = null;
  let stopPromise: Promise<void> | null = null;
  let removeSignalHandlers = () => {};

  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (renewalTimer) clearInterval(renewalTimer);
      if (alertMonitor) await alertMonitor.stop();
      if (runner) await runner.stop();
      if (releaseLease) releaseTelegramBotLease(ownerId);
      removeSignalHandlers();
    })();
    return stopPromise;
  };

  try {
    const me = await bot.api.getMe();
    if (!me.username || me.username.toLowerCase() !== expectedUsername(env)) {
      throw new Error("Telegram bot username does not match configuration");
    }
    bot.botInfo = me;

    const webhook = await bot.api.getWebhookInfo();
    if (webhook.url) {
      if (!allowsWebhookDeletion(env)) throw new Error("Telegram webhook is configured");
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    }

    if (!acquireTelegramBotLease(ownerId, new Date(), LEASE_MS)) {
      throw new Error("Telegram bot lease is already held");
    }
    releaseLease = true;

    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== "getUpdates") return prev(method, payload, signal);
      const cursor = getTelegramLastProcessedUpdateId();
      const offset = cursor === null ? payload.offset : Math.max(payload.offset ?? 0, cursor + 1);
      return prev(method, { ...payload, offset } as never, signal);
    });
    bot.use(async (ctx, next) => {
      await next();
      setTelegramLastProcessedUpdateId(ctx.update.update_id);
    });
    createTelegramTokenBot({
      bot,
      consumeClaim: consumeTelegramLinkClaim,
      getSubscription: getTelegramSubscriptionByChat,
      setMute: setTelegramMute,
      disconnect: disconnectTelegramSubscription,
      getUsage: getApiKeyCustomerUsageById,
      ...options.deps,
    });
    bot.catch(() => undefined);

    await bot.api.setMyCommands([
      { command: "start", description: "Kết nối QRouter" },
      { command: "status", description: "Trạng thái kết nối" },
      { command: "usage", description: "Mức sử dụng" },
      { command: "alerts", description: "Cảnh báo" },
      { command: "mute", description: "Tắt cảnh báo 24 giờ" },
      { command: "unmute", description: "Bật lại cảnh báo" },
      { command: "disconnect", description: "Ngắt kết nối" },
      { command: "help", description: "Trợ giúp" },
    ]);

    runner = runBot(bot, {
      runner: { fetch: { allowed_updates: ["message", "callback_query"] }, silent: true },
      sink: { concurrency: 1 },
    });
    alertMonitor = startMonitor(
      {
        listSubscriptions: listActiveTelegramSubscriptions,
        getUsage: (apiKeyId, now) => getApiKeyCustomerUsageById(apiKeyId, { now }),
        claimDelivery: claimTelegramAlertDelivery,
        recordDelivery: recordTelegramAlertDelivery,
        disconnect: disconnectTelegramSubscription,
        sendMessage: (chatId, text) =>
          bot.api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
      },
      60_000
    );
    renewalTimer = setInterval(() => {
      if (!renewTelegramBotLease(ownerId, new Date(), LEASE_MS)) void stop();
    }, LEASE_RENEWAL_MS);

    if (options.registerSignalHandlers !== false) {
      const onSignal = async () => {
        await stop();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      removeSignalHandlers = () => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      };
    }

    return { bot, stop };
  } catch {
    await stop();
    throw new Error("Telegram token bot failed to start");
  }
}
