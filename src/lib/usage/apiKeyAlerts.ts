import { dispatchEvent } from "@/lib/webhookDispatcher";

type AlertLevel = "warning" | "critical" | "exhausted";
type AlertMetric = "daily_tokens" | "lifetime_tokens" | "key_expiry";

export interface ApiKeyUsageAlert {
  id: string;
  metric: AlertMetric;
  level: AlertLevel;
  thresholdPercent: number | null;
  usedPercent: number | null;
  title: string;
  message: string;
  resetAt: string | null;
  expiresAt?: string | null;
}

export interface BuildApiKeyUsageAlertInput {
  keyName?: string | null;
  dailyTokenLimit?: number | null;
  dailyTokenUsed?: number | null;
  dailyReservedTokens?: number | null;
  dailyResetAt?: string | null;
  lifetimeTokenLimit?: number | null;
  lifetimeTokenUsed?: number | null;
  expiresAt?: string | null;
  now?: Date;
}

const THRESHOLDS = [100, 95, 90] as const;
const emittedThresholds = new Set<string>();

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function calculatePercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function alertLevel(percent: number): AlertLevel {
  if (percent >= 100) return "exhausted";
  if (percent >= 95) return "critical";
  return "warning";
}

function keyForThreshold(
  apiKeyId: string,
  metric: AlertMetric,
  resetAt: string | null,
  threshold: number
) {
  return `${apiKeyId}:${metric}:${resetAt ?? "none"}:${threshold}`;
}

function cleanupOldThresholds(resetAt: string | null, nowMs: number): void {
  if (!resetAt) return;
  const resetMs = new Date(resetAt).getTime();
  if (!Number.isFinite(resetMs) || resetMs > nowMs) return;
  for (const entry of emittedThresholds) {
    if (entry.includes(`:${resetAt}:`)) {
      emittedThresholds.delete(entry);
    }
  }
}

function buildTokenAlert(params: {
  id: string;
  metric: AlertMetric;
  label: string;
  limit: number | null;
  used: number | null;
  reserved?: number | null;
  resetAt: string | null;
}): ApiKeyUsageAlert | null {
  const limit = toFiniteNumber(params.limit);
  const used = toFiniteNumber(params.used);
  const reserved = toFiniteNumber(params.reserved) ?? 0;
  if (limit === null || limit <= 0 || used === null) return null;

  const effectiveUsed = used + Math.max(0, reserved);
  const percent = calculatePercent(effectiveUsed, limit);
  if (percent === null || percent < 90) return null;

  const reachedThreshold = percent >= 100 ? 100 : percent >= 95 ? 95 : 90;
  return {
    id: params.id,
    metric: params.metric,
    level: alertLevel(percent),
    thresholdPercent: reachedThreshold,
    usedPercent: percent,
    title:
      reachedThreshold >= 100
        ? `${params.label} exhausted`
        : `${params.label} reached ${reachedThreshold}%`,
    message:
      reachedThreshold >= 100
        ? `${params.label} is out. Used ${Math.round(effectiveUsed)} / ${Math.round(limit)} tokens.`
        : `${params.label} is at ${Math.round(percent)}%. Used ${Math.round(effectiveUsed)} / ${Math.round(limit)} tokens.`,
    resetAt: params.resetAt,
  };
}

function buildExpiryAlert(
  expiresAt: string | null | undefined,
  now: Date
): ApiKeyUsageAlert | null {
  if (!expiresAt) return null;
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return null;
  const deltaMs = expiryMs - now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (deltaMs <= 0) {
    return {
      id: "key-expired",
      metric: "key_expiry",
      level: "exhausted",
      thresholdPercent: null,
      usedPercent: null,
      title: "Key expired",
      message: "This key has expired.",
      resetAt: null,
      expiresAt,
    };
  }
  if (deltaMs > 7 * dayMs) return null;
  const daysLeft = deltaMs <= dayMs ? "< 1 day" : `${Math.ceil(deltaMs / dayMs)} days`;
  return {
    id: "key-expiry-warning",
    metric: "key_expiry",
    level: deltaMs <= dayMs ? "critical" : "warning",
    thresholdPercent: null,
    usedPercent: null,
    title: "Key expiring soon",
    message: `This key expires in ${daysLeft}.`,
    resetAt: null,
    expiresAt,
  };
}

export function buildApiKeyUsageAlerts(input: BuildApiKeyUsageAlertInput): ApiKeyUsageAlert[] {
  const now = input.now ?? new Date();
  const alerts = [
    buildTokenAlert({
      id: "daily-token-alert",
      metric: "daily_tokens",
      label: "Daily token quota",
      limit: input.dailyTokenLimit ?? null,
      used: input.dailyTokenUsed ?? null,
      reserved: input.dailyReservedTokens ?? null,
      resetAt: input.dailyResetAt ?? null,
    }),
    buildTokenAlert({
      id: "lifetime-token-alert",
      metric: "lifetime_tokens",
      label: "Lifetime token quota",
      limit: input.lifetimeTokenLimit ?? null,
      used: input.lifetimeTokenUsed ?? null,
      reserved: 0,
      resetAt: null,
    }),
    buildExpiryAlert(input.expiresAt, now),
  ].filter((alert): alert is ApiKeyUsageAlert => Boolean(alert));

  return alerts.sort((a, b) => {
    const severity = { exhausted: 3, critical: 2, warning: 1 };
    return severity[b.level] - severity[a.level];
  });
}

export async function dispatchApiKeyThresholdAlerts(input: {
  apiKeyId: string;
  apiKeyName?: string | null;
  maskedKey?: string | null;
  dailyTokenLimit?: number | null;
  dailyTokenUsed?: number | null;
  dailyReservedTokens?: number | null;
  dailyResetAt?: string | null;
  lifetimeTokenLimit?: number | null;
  lifetimeTokenUsed?: number | null;
  expiresAt?: string | null;
  now?: Date;
  dispatch?: typeof dispatchEvent;
}): Promise<void> {
  const now = input.now ?? new Date();
  const dispatch = input.dispatch ?? dispatchEvent;
  cleanupOldThresholds(input.dailyResetAt ?? null, now.getTime());

  const alerts = buildApiKeyUsageAlerts({
    keyName: input.apiKeyName,
    dailyTokenLimit: input.dailyTokenLimit,
    dailyTokenUsed: input.dailyTokenUsed,
    dailyReservedTokens: input.dailyReservedTokens,
    dailyResetAt: input.dailyResetAt,
    lifetimeTokenLimit: input.lifetimeTokenLimit,
    lifetimeTokenUsed: input.lifetimeTokenUsed,
    expiresAt: input.expiresAt,
    now,
  });

  const quotaAlerts = alerts.filter(
    (alert) =>
      (alert.metric === "daily_tokens" || alert.metric === "lifetime_tokens") && alert.usedPercent
  );

  for (const alert of quotaAlerts) {
    const threshold = THRESHOLDS.find((entry) => (alert.usedPercent ?? 0) >= entry);
    if (!threshold) continue;
    const dedupeKey = keyForThreshold(
      input.apiKeyId,
      alert.metric,
      alert.metric === "daily_tokens" ? (input.dailyResetAt ?? null) : null,
      threshold
    );
    if (emittedThresholds.has(dedupeKey)) continue;
    emittedThresholds.add(dedupeKey);
    await dispatch("quota.exceeded", {
      apiKeyId: input.apiKeyId,
      apiKeyName: input.apiKeyName ?? null,
      keyPrefix: input.maskedKey ?? null,
      metric: alert.metric,
      level: alert.level,
      thresholdPercent: threshold,
      usedPercent: alert.usedPercent,
      message: alert.message,
      resetAt: alert.resetAt,
      expiresAt: input.expiresAt ?? null,
      checkedAt: now.toISOString(),
    });
  }
}
