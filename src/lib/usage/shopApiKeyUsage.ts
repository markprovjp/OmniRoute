import { createHash } from "node:crypto";
import type { QuotaMetric } from "@/shared/contracts/quota";

const SHOP_APIKEY_USAGE_URL = "https://shopapikey.com/api/public/usage";
const SHOP_APIKEY_CACHE_TTL_MS = 60_000;

type JsonRecord = Record<string, unknown>;

export interface ShopApiKeyUsageSnapshot {
  requestQuota: QuotaMetric | null;
  tokenQuota: QuotaMetric | null;
  checkedAt: string | null;
}

interface CachedUsageSnapshot {
  snapshot: ShopApiKeyUsageSnapshot;
  fetchedAt: number;
}

const usageCache = new Map<string, CachedUsageSnapshot>();

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function clampQuotaValue(value: number, limit: number | null): number {
  if (limit === null) return Math.max(0, value);
  return Math.min(limit, Math.max(0, value));
}

function parseQuotaMetric(value: unknown): QuotaMetric | null {
  const source = toRecord(value);
  const limitRaw = toNumber(source.limit);
  const usedRaw = toNumber(source.used);
  const remainingRaw = toNumber(source.remaining);
  const effectiveUsedRaw = toNumber(source.effectiveUsed);
  const reservedRaw = toNumber(source.reserved);
  const limit = limitRaw !== null && limitRaw >= 0 ? limitRaw : null;

  if (usedRaw === null && remainingRaw === null && limit === null) return null;

  const used = clampQuotaValue(usedRaw ?? effectiveUsedRaw ?? 0, limit);
  const remaining =
    remainingRaw !== null
      ? clampQuotaValue(remainingRaw, limit)
      : limit !== null
        ? Math.max(0, limit - used)
        : null;

  return {
    limit,
    used,
    remaining,
    percentRemaining:
      limit !== null && limit > 0 && remaining !== null ? (remaining / limit) * 100 : null,
    resetAt: toTimestamp(source.resetAt),
    ...(reservedRaw !== null ? { reserved: Math.max(0, reservedRaw) } : {}),
    ...(effectiveUsedRaw !== null ? { effectiveUsed: Math.max(0, effectiveUsedRaw) } : {}),
  };
}

function getCacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function isShopApiKeyUsageBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    return new URL(value).hostname.toLowerCase() === "shopapikey.com";
  } catch {
    return false;
  }
}

export function parseShopApiKeyUsageSnapshot(value: unknown): ShopApiKeyUsageSnapshot | null {
  const source = toRecord(value);
  if (source.success !== true) return null;

  const usage = toRecord(source.usage);
  const requestQuota = parseQuotaMetric(usage.requestQuota);
  const tokenQuota = parseQuotaMetric(usage.tokenQuota);
  if (!requestQuota && !tokenQuota) return null;

  return {
    requestQuota,
    tokenQuota,
    checkedAt: toTimestamp(source.checkedAt),
  };
}

export async function fetchShopApiKeyPublicUsage(
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<ShopApiKeyUsageSnapshot | null> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return null;

  const cacheKey = getCacheKey(trimmedKey);
  const cached = usageCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SHOP_APIKEY_CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const response = await fetcher(SHOP_APIKEY_USAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: trimmedKey }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;

  const snapshot = parseShopApiKeyUsageSnapshot(await response.json());
  if (snapshot) {
    usageCache.set(cacheKey, { snapshot, fetchedAt: Date.now() });
  }
  return snapshot;
}

export function __resetShopApiKeyUsageCacheForTests() {
  usageCache.clear();
}
