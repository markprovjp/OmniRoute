import { maskStoredApiKey } from "@/lib/apiKeyExposure";
import { getApiKeyById } from "@/lib/db/apiKeys";
import { buildApiKeyUsageAlerts, type ApiKeyUsageAlert } from "@/lib/usage/apiKeyAlerts";
import {
  getApiKeyModelUsage,
  getApiKeyUsageSummaries,
  getBangkokUsageWindow,
} from "@/lib/usage/apiKeyUsageSummary";
import { getApiKeyQuotaSnapshot } from "@/lib/usage/apiKeyQuotaLedger";

type ApiKeyState = "active" | "banned" | "disabled" | "expired";

interface ApiKeyCustomerUsageSource {
  id?: string;
  name?: string;
  keyPrefix?: string | null;
  isActive?: boolean;
  isBanned?: boolean;
  expiresAt?: string | null;
  maxRequestsPerDay?: number | null;
  tokenLimit?: number | null;
  dailyTokenLimit?: number | null;
  hourlyTokenLimit?: number | null;
  tokenUsed?: number | null;
}

export interface ApiKeyCustomerUsageOptions {
  rawKeyForMasking?: string | null;
  now?: Date;
}

export interface ApiKeyCustomerUsage {
  success: true;
  checkedAt: string;
  object: "api_key_usage";
  key: {
    name: string;
    prefix: string | null;
    state: ApiKeyState;
    expires_at: string | null;
  };
  requests: {
    today: number;
    hour: number;
    total: number;
    limit: number | null;
    remaining: number | null;
    reset_at: string;
  };
  tokens: {
    today: number;
    hour: number;
    total: number;
    input: number;
    output: number;
    limit: number | null;
    remaining: number | null;
    daily_limit: number | null;
    daily_remaining: number | null;
    hourly_limit: number | null;
    hourly_remaining: number | null;
    reset_at: string;
  };
  usage: {
    all: ApiKeyCustomerUsageTotals;
    today: ApiKeyCustomerUsageTotals;
    lastHour: ApiKeyCustomerUsageHourTotals;
    byModel: ApiKeyCustomerUsageModel[];
  };
  quotaUsage: {
    totalTokenUsed: number;
    lifetimeTokenUsed: number;
    dailyTokenUsed: number;
    dailyReservedTokens: number;
    hourlyTokenUsed: number;
    hourlyReservedTokens: number;
  };
  requestQuota: {
    limit: number | null;
    used: number;
    remaining: number | null;
    resetAt: string;
  };
  tokenQuota: {
    limit: number | null;
    used: number;
    reserved: number;
    effectiveUsed: number;
    remaining: number | null;
    resetAt: string | null;
  };
  alerts: ApiKeyUsageAlert[];
  models: ApiKeyCustomerUsageModel[];
}

interface ApiKeyCustomerUsageTotals {
  requests: number;
  promptGptTokens: number;
  completionGptTokens: number;
  totalGptTokens: number;
}

interface ApiKeyCustomerUsageHourTotals {
  requests: number;
  totalGptTokens: number;
}

interface ApiKeyCustomerUsageModel {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_used_at: string | null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function keyState(apiKey: ApiKeyCustomerUsageSource, now: Date): ApiKeyState {
  if (apiKey.isBanned === true) return "banned";
  if (apiKey.isActive === false) return "disabled";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

function serializeModels(apiKeyId: string): ApiKeyCustomerUsageModel[] {
  return getApiKeyModelUsage(apiKeyId).map((row) => ({
    model: row.model,
    requests: row.requests,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    total_tokens: row.totalTokens,
    last_used_at: row.lastUsed,
  }));
}

export function buildApiKeyCustomerUsage(
  apiKey: ApiKeyCustomerUsageSource,
  options: ApiKeyCustomerUsageOptions = {}
): ApiKeyCustomerUsage {
  const apiKeyId = apiKey.id;
  if (!apiKeyId) throw new Error("API key id is required");

  const now = options.now ?? new Date();
  const window = getBangkokUsageWindow(now);
  const measured = getApiKeyUsageSummaries([apiKeyId])[apiKeyId];
  const quota = getApiKeyQuotaSnapshot(apiKeyId, now);
  const requestsToday = quota.day?.requestCount ?? measured.todayRequests;
  const totalTokens = Math.max(measured.totalTokens, toNumber(apiKey.tokenUsed));
  const requestLimit = toNumber(apiKey.maxRequestsPerDay) || null;
  const tokenLimit = toNumber(apiKey.tokenLimit) || null;
  const dailyTokenLimit = toNumber(apiKey.dailyTokenLimit) || quota.day?.tokenLimit || null;
  const hourlyTokenLimit = toNumber(apiKey.hourlyTokenLimit) || quota.hour?.tokenLimit || null;
  const quotaTotalUsed = Math.max(
    totalTokens,
    (quota.day?.usedTokens ?? 0) + (quota.day?.reservedTokens ?? 0),
    (quota.hour?.usedTokens ?? 0) + (quota.hour?.reservedTokens ?? 0)
  );
  const requestsRemaining =
    requestLimit === null ? null : Math.max(0, requestLimit - requestsToday);
  const tokensRemaining = tokenLimit === null ? null : Math.max(0, tokenLimit - totalTokens);
  const serializedModels = serializeModels(apiKeyId);
  const expiresAt = toStringOrNull(apiKey.expiresAt);
  const alerts = buildApiKeyUsageAlerts({
    keyName: apiKey.name || "API key",
    dailyTokenLimit,
    dailyTokenUsed: quota.day?.usedTokens ?? measured.todayTokens,
    dailyReservedTokens: quota.day?.reservedTokens ?? 0,
    dailyResetAt: quota.day?.resetAt ?? window.resetIso,
    lifetimeTokenLimit: tokenLimit,
    lifetimeTokenUsed: totalTokens,
    expiresAt,
    now,
  });

  return {
    success: true,
    checkedAt: now.toISOString(),
    object: "api_key_usage",
    key: {
      name: apiKey.name || "API key",
      prefix: maskStoredApiKey(options.rawKeyForMasking ?? apiKey.keyPrefix),
      state: keyState(apiKey, now),
      expires_at: expiresAt,
    },
    requests: {
      today: requestsToday,
      hour: measured.hourRequests,
      total: measured.totalRequests,
      limit: requestLimit,
      remaining: requestsRemaining,
      reset_at: window.resetIso,
    },
    tokens: {
      today: measured.todayTokens,
      hour: measured.hourTokens,
      total: totalTokens,
      input: measured.inputTokens,
      output: measured.outputTokens,
      limit: tokenLimit,
      remaining: tokensRemaining,
      daily_limit: dailyTokenLimit,
      daily_remaining:
        quota.day?.remainingTokens ??
        (dailyTokenLimit === null ? null : Math.max(0, dailyTokenLimit - measured.todayTokens)),
      hourly_limit: hourlyTokenLimit,
      hourly_remaining:
        quota.hour?.remainingTokens ??
        (hourlyTokenLimit === null ? null : Math.max(0, hourlyTokenLimit - measured.hourTokens)),
      reset_at: window.resetIso,
    },
    usage: {
      all: {
        requests: measured.totalRequests,
        promptGptTokens: measured.inputTokens,
        completionGptTokens: measured.outputTokens,
        totalGptTokens: totalTokens,
      },
      today: {
        requests: requestsToday,
        promptGptTokens: 0,
        completionGptTokens: 0,
        totalGptTokens: measured.todayTokens,
      },
      lastHour: {
        requests: measured.hourRequests,
        totalGptTokens: measured.hourTokens,
      },
      byModel: serializedModels,
    },
    quotaUsage: {
      totalTokenUsed: quotaTotalUsed,
      lifetimeTokenUsed: totalTokens,
      dailyTokenUsed: quota.day?.usedTokens ?? measured.todayTokens,
      dailyReservedTokens: quota.day?.reservedTokens ?? 0,
      hourlyTokenUsed: quota.hour?.usedTokens ?? measured.hourTokens,
      hourlyReservedTokens: quota.hour?.reservedTokens ?? 0,
    },
    requestQuota: {
      limit: requestLimit,
      used: requestsToday,
      remaining: requestsRemaining,
      resetAt: window.resetIso,
    },
    tokenQuota: {
      limit: dailyTokenLimit || tokenLimit,
      used: quota.day?.usedTokens ?? measured.todayTokens,
      reserved: quota.day?.reservedTokens ?? 0,
      effectiveUsed:
        (quota.day?.usedTokens ?? measured.todayTokens) + (quota.day?.reservedTokens ?? 0),
      remaining:
        quota.day?.remainingTokens ??
        (dailyTokenLimit === null
          ? tokensRemaining
          : Math.max(0, dailyTokenLimit - measured.todayTokens)),
      resetAt: quota.day?.resetAt ?? (dailyTokenLimit === null ? null : window.resetIso),
    },
    alerts,
    models: serializedModels,
  };
}

export async function getApiKeyCustomerUsageById(
  apiKeyId: string,
  options: ApiKeyCustomerUsageOptions = {}
): Promise<ApiKeyCustomerUsage | null> {
  const apiKey = await getApiKeyById(apiKeyId);
  return apiKey ? buildApiKeyCustomerUsage(apiKey, options) : null;
}
