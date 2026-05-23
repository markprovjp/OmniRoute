import { NextResponse } from "next/server";
import { getProviderConnections, getProviderNodeById, saveQuotaSnapshot } from "@/lib/localDb";
import {
  getLearnedLimits,
  getRateLimitStatus,
} from "@omniroute/open-sse/services/rateLimitManager.ts";
import {
  normalizeQuotaResponse,
  sanitizeQuotaProvider,
  type QuotaMetric,
  type QuotaProviderEntry,
  type QuotaTokenStatus,
} from "@/shared/contracts/quota";
import {
  fetchShopApiKeyPublicUsage,
  isShopApiKeyUsageBaseUrl,
  type ShopApiKeyUsageSnapshot,
} from "@/lib/usage/shopApiKeyUsage";

type ProviderConnectionRecord = Record<string, unknown>;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toDateMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveTokenStatus(connection: ProviderConnectionRecord): QuotaTokenStatus {
  const testStatus =
    typeof connection.testStatus === "string" ? connection.testStatus.toLowerCase() : "";

  if (testStatus === "expired") return "expired";
  if (testStatus === "refreshing") return "refreshing";

  const expiresAtMs = toDateMs(connection.tokenExpiresAt);
  if (expiresAtMs !== null) {
    const msRemaining = expiresAtMs - Date.now();
    if (msRemaining <= 0) return "expired";
    if (msRemaining <= 15 * 60 * 1000) return "expiring";
  }

  const lastErrorType =
    typeof connection.lastErrorType === "string" ? connection.lastErrorType.toLowerCase() : "";
  if (lastErrorType.includes("refresh")) return "expiring";

  return "valid";
}

function buildQuotaEntry(
  connection: ProviderConnectionRecord,
  learnedLimit: unknown,
  rateStatus: Record<string, unknown>
): QuotaProviderEntry {
  const provider =
    typeof connection.provider === "string" && connection.provider.trim()
      ? connection.provider
      : "unknown";
  const connectionId =
    typeof connection.id === "string" && connection.id.trim() ? connection.id : "unknown";
  const name =
    (typeof connection.name === "string" && connection.name.trim()) ||
    (typeof connection.email === "string" && connection.email.trim()) ||
    provider;

  const resetAt =
    typeof connection.rateLimitedUntil === "string" && connection.rateLimitedUntil.trim()
      ? connection.rateLimitedUntil
      : null;

  let quotaTotal: number | null = null;
  let quotaUsed = 0;
  let percentRemaining = 100;
  const learned =
    learnedLimit && typeof learnedLimit === "object" && !Array.isArray(learnedLimit)
      ? (learnedLimit as Record<string, unknown>)
      : null;

  const learnedLimitValue =
    learned && typeof learned.limit === "number" && Number.isFinite(learned.limit)
      ? learned.limit
      : null;
  const learnedRemainingValue =
    learned && typeof learned.remaining === "number" && Number.isFinite(learned.remaining)
      ? learned.remaining
      : null;

  if (learnedLimitValue !== null && learnedLimitValue > 0) {
    quotaTotal = learnedLimitValue;
    const remaining =
      learnedRemainingValue !== null
        ? Math.min(Math.max(learnedRemainingValue, 0), learnedLimitValue)
        : learnedLimitValue;
    quotaUsed = learnedLimitValue - remaining;
    percentRemaining = (remaining / learnedLimitValue) * 100;
  } else {
    const resetAtMs = toDateMs(resetAt);
    if (resetAtMs !== null && resetAtMs > Date.now()) {
      quotaTotal = 100;
      quotaUsed = 100;
      percentRemaining = 0;
    } else {
      // Fallback synthetic signal from queue pressure when limit headers are unavailable.
      const queued = typeof rateStatus.queued === "number" ? rateStatus.queued : 0;
      const running = typeof rateStatus.running === "number" ? rateStatus.running : 0;
      const executing = typeof rateStatus.executing === "number" ? rateStatus.executing : 0;

      const syntheticUsage = Math.min(95, queued * 10 + running * 5 + executing * 3);
      if (syntheticUsage > 0) {
        quotaTotal = 100;
        quotaUsed = syntheticUsage;
        percentRemaining = 100 - syntheticUsage;
      }
    }
  }

  return sanitizeQuotaProvider({
    name,
    provider,
    connectionId,
    quotaUsed,
    quotaTotal,
    percentRemaining,
    resetAt,
    tokenStatus: deriveTokenStatus(connection),
  });
}

function getMetricPercentRemaining(metric: QuotaMetric | null): number | null {
  if (!metric) return null;
  if (typeof metric.percentRemaining === "number" && Number.isFinite(metric.percentRemaining)) {
    return Math.min(100, Math.max(0, metric.percentRemaining));
  }
  if (metric.limit && metric.limit > 0 && metric.remaining !== null) {
    return Math.min(100, Math.max(0, (metric.remaining / metric.limit) * 100));
  }
  return null;
}

function saveShopApiKeyQuotaSnapshot(
  connection: ProviderConnectionRecord,
  windowKey: string,
  metric: QuotaMetric | null
) {
  const provider = typeof connection.provider === "string" ? connection.provider : "unknown";
  const connectionId = typeof connection.id === "string" ? connection.id : "unknown";
  const remainingPercentage = getMetricPercentRemaining(metric);
  if (!metric || remainingPercentage === null || connectionId === "unknown") return;

  saveQuotaSnapshot({
    provider,
    connection_id: connectionId,
    window_key: windowKey,
    remaining_percentage: remainingPercentage,
    is_exhausted: metric.remaining === 0 ? 1 : 0,
    next_reset_at: metric.resetAt,
    window_duration_ms: null,
    raw_data: JSON.stringify(metric),
  });
}

function buildShopApiKeyQuotaEntry(
  baseEntry: QuotaProviderEntry,
  usage: ShopApiKeyUsageSnapshot
): QuotaProviderEntry {
  const primaryQuota = usage.tokenQuota || usage.requestQuota;
  const percentRemaining = getMetricPercentRemaining(primaryQuota);

  return sanitizeQuotaProvider({
    ...baseEntry,
    quotaUsed: primaryQuota?.used ?? baseEntry.quotaUsed,
    quotaTotal: primaryQuota?.limit ?? baseEntry.quotaTotal,
    percentRemaining: percentRemaining ?? baseEntry.percentRemaining,
    resetAt: primaryQuota?.resetAt ?? baseEntry.resetAt,
    requestQuota: usage.requestQuota,
    tokenQuota: usage.tokenQuota,
    checkedAt: usage.checkedAt,
    quotaSource: "shopapikey-public-usage",
  });
}

function getConnectionBaseUrl(connection: ProviderConnectionRecord): string | null {
  const providerSpecificData = toRecord(connection.providerSpecificData);
  return typeof providerSpecificData.baseUrl === "string" && providerSpecificData.baseUrl.trim()
    ? providerSpecificData.baseUrl
    : null;
}

async function getShopApiKeyUsageIfSupported(
  connection: ProviderConnectionRecord
): Promise<ShopApiKeyUsageSnapshot | null> {
  const apiKey = typeof connection.apiKey === "string" ? connection.apiKey : "";
  if (!apiKey.trim()) return null;

  let baseUrl = getConnectionBaseUrl(connection);
  if (!baseUrl && typeof connection.provider === "string") {
    const node = (await getProviderNodeById(connection.provider)) as Record<string, unknown> | null;
    baseUrl = typeof node?.baseUrl === "string" ? node.baseUrl : null;
  }
  if (!isShopApiKeyUsageBaseUrl(baseUrl)) return null;

  return fetchShopApiKeyPublicUsage(apiKey);
}

/**
 * GET /api/usage/quota
 *
 * Query params:
 *   - provider (optional): filter by provider slug
 *   - connectionId (optional): filter by provider connection id
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerFilter = searchParams.get("provider");
    const connectionIdFilter = searchParams.get("connectionId");

    const connectionsRaw = await getProviderConnections({ isActive: true });
    let connections = Array.isArray(connectionsRaw) ? connectionsRaw : [];

    if (providerFilter) {
      connections = connections.filter((conn) => conn.provider === providerFilter);
    }
    if (connectionIdFilter) {
      connections = connections.filter((conn) => conn.id === connectionIdFilter);
    }

    const learnedLimits = getLearnedLimits();
    const providers = await Promise.all(
      connections.map(async (conn) => {
        const learnedLimit = learnedLimits?.[`${conn.provider}:${conn.id}`] || null;
        const rateStatus = getRateLimitStatus(conn.provider, conn.id);
        const quotaEntry = buildQuotaEntry(conn, learnedLimit, rateStatus);

        try {
          const shopApiKeyUsage = await getShopApiKeyUsageIfSupported(conn);
          if (shopApiKeyUsage) {
            saveShopApiKeyQuotaSnapshot(conn, "shopapikey:requests", shopApiKeyUsage.requestQuota);
            saveShopApiKeyQuotaSnapshot(conn, "shopapikey:tokens", shopApiKeyUsage.tokenQuota);
            return buildShopApiKeyQuotaEntry(quotaEntry, shopApiKeyUsage);
          }
        } catch (error) {
          console.warn(
            `[API] GET /api/usage/quota shopapikey usage fetch failed for ${conn.provider}:${conn.id}:`,
            error
          );
        }

        return quotaEntry;
      })
    );

    const response = normalizeQuotaResponse(
      {
        providers,
        meta: {
          generatedAt: new Date().toISOString(),
          filters: {
            provider: providerFilter,
            connectionId: connectionIdFilter,
          },
        },
      },
      {
        provider: providerFilter,
        connectionId: connectionIdFilter,
      }
    );

    return NextResponse.json(response);
  } catch (error) {
    console.error("[API] GET /api/usage/quota error:", error);
    return NextResponse.json({ error: "Failed to fetch quota data" }, { status: 500 });
  }
}
