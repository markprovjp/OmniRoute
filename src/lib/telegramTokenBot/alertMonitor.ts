import type {
  TelegramAlertDeliveryClaim,
  TelegramAlertDeliveryErrorCode,
  TelegramAlertDeliveryUpdate,
  TelegramSubscription,
} from "@/lib/db/telegramBot";
import type { ApiKeyCustomerUsage } from "@/lib/usage/apiKeyCustomerUsage";
import { escapeTelegramHtml } from "./messages";

const TOKEN_THRESHOLDS = [90, 95, 100] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;

interface TelegramMessageResult {
  message_id: number | string;
}

interface TelegramAlertCandidate {
  dedupeKey: string;
  line: string;
}

interface ClaimedTelegramAlert extends TelegramAlertCandidate {
  attemptCount: number;
}

export interface TelegramAlertMonitorDeps {
  listSubscriptions: () => TelegramSubscription[];
  getUsage: (apiKeyId: string, now: Date) => Promise<ApiKeyCustomerUsage | null>;
  claimDelivery: (
    subscriptionId: string,
    dedupeKey: string,
    now: Date
  ) => TelegramAlertDeliveryClaim | null;
  recordDelivery: (
    subscriptionId: string,
    dedupeKey: string,
    update: TelegramAlertDeliveryUpdate,
    now: Date
  ) => boolean;
  disconnect: (chatId: string, now?: Date) => boolean;
  sendMessage: (chatId: string, text: string) => Promise<TelegramMessageResult>;
}

export interface TelegramAlertSweepResult {
  subscriptionsScanned: number;
  messagesSent: number;
  alertsDelivered: number;
  skippedMuted: number;
  subscriptionsDisabled: number;
  rateLimited: number;
  failures: number;
}

export interface TelegramAlertMonitor {
  runNow: () => Promise<TelegramAlertSweepResult | null>;
  stop: () => Promise<void>;
}

export function telegramAlertDedupeKey(input: {
  metric: "daily_tokens" | "lifetime_tokens" | "key_expiry";
  threshold: number | string;
  resetAt?: string | null;
  configuredLimit?: number | string | null;
}): string {
  return [
    input.metric,
    input.threshold,
    input.resetAt ?? "never",
    input.configuredLimit ?? "none",
  ].join(":");
}

function emptySweepResult(): TelegramAlertSweepResult {
  return {
    subscriptionsScanned: 0,
    messagesSent: 0,
    alertsDelivered: 0,
    skippedMuted: 0,
    subscriptionsDisabled: 0,
    rateLimited: 0,
    failures: 0,
  };
}

function isMuted(subscription: TelegramSubscription, now: Date): boolean {
  if (!subscription.mutedUntil) return false;
  const mutedUntil = new Date(subscription.mutedUntil).getTime();
  return Number.isFinite(mutedUntil) && mutedUntil > now.getTime();
}

function tokenAlertCandidates(usage: ApiKeyCustomerUsage): TelegramAlertCandidate[] {
  const candidates: TelegramAlertCandidate[] = [];
  for (const alert of usage.alerts) {
    if (alert.metric !== "daily_tokens" && alert.metric !== "lifetime_tokens") continue;
    const usedPercent = alert.usedPercent ?? 0;
    const configuredLimit =
      alert.metric === "daily_tokens" ? usage.tokens.daily_limit : usage.tokens.limit;
    const resetAt = alert.metric === "daily_tokens" ? alert.resetAt : null;
    const label = alert.metric === "daily_tokens" ? "Token ngày" : "Tổng token";

    for (const threshold of TOKEN_THRESHOLDS) {
      if (usedPercent < threshold) continue;
      candidates.push({
        dedupeKey: telegramAlertDedupeKey({
          metric: alert.metric,
          threshold,
          resetAt,
          configuredLimit,
        }),
        line:
          threshold === 100
            ? `• ${label} đã đạt <b>100%</b> — hạn mức đã hết.`
            : `• ${label} đã đạt <b>${threshold}%</b>.`,
      });
    }
  }
  return candidates;
}

function expiryAlertCandidate(
  usage: ApiKeyCustomerUsage,
  now: Date
): TelegramAlertCandidate | null {
  const expiryAlert = usage.alerts.find((alert) => alert.metric === "key_expiry");
  const expiresAt = expiryAlert?.expiresAt ?? usage.key.expires_at;
  if (!expiryAlert || !expiresAt) return null;

  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return null;
  const remainingMs = expiryMs - now.getTime();
  const threshold = remainingMs <= 0 ? "expired" : remainingMs <= DAY_MS ? "1d" : "7d";
  const line =
    threshold === "expired"
      ? "• API key <b>đã hết hạn</b>."
      : threshold === "1d"
        ? "• API key sẽ hết hạn trong <b>1 ngày</b>."
        : "• API key sẽ hết hạn trong <b>7 ngày</b>.";

  return {
    dedupeKey: telegramAlertDedupeKey({
      metric: "key_expiry",
      threshold,
      configuredLimit: expiresAt,
    }),
    line,
  };
}

function alertCandidates(usage: ApiKeyCustomerUsage, now: Date): TelegramAlertCandidate[] {
  const candidates = tokenAlertCandidates(usage);
  const expiry = expiryAlertCandidate(usage, now);
  if (expiry) candidates.push(expiry);
  return candidates;
}

function formatAlertMessage(usage: ApiKeyCustomerUsage, alerts: ClaimedTelegramAlert[]): string {
  return [
    "<b>Cảnh báo QRouter</b>",
    `<b>${escapeTelegramHtml(usage.key.name)}</b>`,
    "",
    ...alerts.map((alert) => alert.line),
    "",
    "Gửi lại API key cho bot để xem Usage hoặc đổi trạng thái cảnh báo.",
  ].join("\n");
}

function telegramErrorDetails(error: unknown): {
  status: number | null;
  retryAfterSeconds: number | null;
  description: string;
} {
  if (!error || typeof error !== "object") {
    return { status: null, retryAfterSeconds: null, description: "" };
  }
  const value = error as {
    error_code?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
    error?: {
      error_code?: unknown;
      description?: unknown;
      parameters?: { retry_after?: unknown };
    };
  };
  const nested = value.error && typeof value.error === "object" ? value.error : null;
  const statusValue = value.error_code ?? nested?.error_code;
  const retryValue = value.parameters?.retry_after ?? nested?.parameters?.retry_after;
  const status = Number.isFinite(Number(statusValue)) ? Number(statusValue) : null;
  const retryAfterSeconds = Number.isFinite(Number(retryValue)) ? Number(retryValue) : null;
  const descriptionValue = value.description ?? nested?.description;
  return {
    status,
    retryAfterSeconds,
    description: typeof descriptionValue === "string" ? descriptionValue.toLowerCase() : "",
  };
}

function classifyTelegramFailure(error: unknown): {
  code: TelegramAlertDeliveryErrorCode;
  retryAfterSeconds: number | null;
  terminal: boolean;
  disableSubscription: boolean;
} {
  const details = telegramErrorDetails(error);
  if (details.status === 403) {
    return {
      code: "telegram_forbidden",
      retryAfterSeconds: null,
      terminal: true,
      disableSubscription: true,
    };
  }
  if (details.status === 429) {
    return {
      code: "telegram_rate_limited",
      retryAfterSeconds: details.retryAfterSeconds,
      terminal: false,
      disableSubscription: false,
    };
  }
  if (details.status === 400) {
    const chatNotFound = details.description.includes("chat not found");
    return {
      code: chatNotFound ? "telegram_chat_not_found" : "telegram_bad_request",
      retryAfterSeconds: null,
      terminal: true,
      disableSubscription: chatNotFound,
    };
  }
  if (details.status !== null && details.status >= 500) {
    return {
      code: "telegram_upstream_error",
      retryAfterSeconds: null,
      terminal: false,
      disableSubscription: false,
    };
  }
  return {
    code: "network_error",
    retryAfterSeconds: null,
    terminal: false,
    disableSubscription: false,
  };
}

function retryAt(now: Date, attemptCount: number, retryAfterSeconds: number | null): Date {
  const boundedRetryAfter =
    retryAfterSeconds === null
      ? null
      : Math.max(1, Math.min(Math.ceil(retryAfterSeconds), MAX_RETRY_AFTER_SECONDS));
  const delayMs =
    boundedRetryAfter === null
      ? DEFAULT_RETRY_MS * 2 ** Math.max(0, attemptCount)
      : boundedRetryAfter * 1000;
  return new Date(now.getTime() + delayMs);
}

function recordAll(
  deps: TelegramAlertMonitorDeps,
  subscription: TelegramSubscription,
  alerts: ClaimedTelegramAlert[],
  update: TelegramAlertDeliveryUpdate,
  now: Date
): void {
  for (const alert of alerts) {
    deps.recordDelivery(subscription.id, alert.dedupeKey, update, now);
  }
}

async function processSubscription(
  deps: TelegramAlertMonitorDeps,
  subscription: TelegramSubscription,
  now: Date,
  result: TelegramAlertSweepResult
): Promise<void> {
  if (isMuted(subscription, now)) {
    result.skippedMuted += 1;
    return;
  }

  let usage: ApiKeyCustomerUsage | null;
  try {
    usage = await deps.getUsage(subscription.apiKeyId, now);
  } catch {
    result.failures += 1;
    return;
  }

  if (!usage) {
    if (deps.disconnect(subscription.chatId, now)) result.subscriptionsDisabled += 1;
    return;
  }

  const candidates = alertCandidates(usage, now);
  if (candidates.length === 0) return;

  const claimed = candidates.flatMap((candidate): ClaimedTelegramAlert[] => {
    const claim = deps.claimDelivery(subscription.id, candidate.dedupeKey, now);
    return claim ? [{ ...candidate, attemptCount: claim.attemptCount }] : [];
  });
  if (claimed.length === 0) return;

  try {
    const message = await deps.sendMessage(subscription.chatId, formatAlertMessage(usage, claimed));
    recordAll(
      deps,
      subscription,
      claimed,
      { status: "sent", telegramMessageId: String(message.message_id) },
      now
    );
    result.messagesSent += 1;
    result.alertsDelivered += claimed.length;
  } catch (error) {
    const failure = classifyTelegramFailure(error);
    for (const alert of claimed) {
      const nextAttempt = alert.attemptCount + 1;
      const terminal = failure.terminal || nextAttempt >= MAX_DELIVERY_ATTEMPTS;
      const update: TelegramAlertDeliveryUpdate = terminal
        ? { status: "failed", errorCode: failure.code }
        : {
            status: "retry",
            errorCode: failure.code,
            retryAt: retryAt(now, nextAttempt - 1, failure.retryAfterSeconds),
          };
      deps.recordDelivery(subscription.id, alert.dedupeKey, update, now);
    }
    if (failure.code === "telegram_rate_limited") result.rateLimited += 1;
    if (failure.disableSubscription && deps.disconnect(subscription.chatId, now)) {
      result.subscriptionsDisabled += 1;
    }
    result.failures += 1;
  }
}

export async function runTelegramAlertSweep(
  deps: TelegramAlertMonitorDeps,
  now = new Date()
): Promise<TelegramAlertSweepResult> {
  const result = emptySweepResult();
  const subscriptions = deps.listSubscriptions();
  result.subscriptionsScanned = subscriptions.length;

  for (const subscription of subscriptions) {
    await processSubscription(deps, subscription, now, result);
  }

  return result;
}

export function startTelegramAlertMonitor(
  deps: TelegramAlertMonitorDeps,
  intervalMs = 60_000
): TelegramAlertMonitor {
  let stopped = false;
  let activeSweep: Promise<TelegramAlertSweepResult> | null = null;

  const runNow = (): Promise<TelegramAlertSweepResult | null> => {
    if (stopped || activeSweep) return Promise.resolve(null);
    activeSweep = runTelegramAlertSweep(deps).finally(() => {
      activeSweep = null;
    });
    return activeSweep;
  };

  void runNow().catch(() => undefined);
  const timer = setInterval(
    () => {
      void runNow().catch(() => undefined);
    },
    Math.max(1_000, intervalMs)
  );

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (activeSweep) await activeSweep;
  };

  return { runNow, stop };
}
