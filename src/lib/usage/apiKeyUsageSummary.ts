import { getDbInstance } from "@/lib/db/core";

type UsageRow = Record<string, unknown>;

export interface ApiKeyUsageSummary {
  totalRequests: number;
  todayRequests: number;
  hourRequests: number;
  totalTokens: number;
  todayTokens: number;
  hourTokens: number;
  inputTokens: number;
  outputTokens: number;
  lastUsed: string | null;
}

export interface ApiKeyModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastUsed: string | null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function getBangkokUsageWindow(now = new Date()) {
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const year = bangkok.getUTCFullYear();
  const month = bangkok.getUTCMonth();
  const day = bangkok.getUTCDate();
  const start = new Date(Date.UTC(year, month, day) - 7 * 60 * 60 * 1000);
  const reset = new Date(Date.UTC(year, month, day + 1) - 7 * 60 * 60 * 1000);
  return {
    hourStartIso: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    startIso: start.toISOString(),
    resetIso: reset.toISOString(),
  };
}

function emptySummary(): ApiKeyUsageSummary {
  return {
    totalRequests: 0,
    todayRequests: 0,
    hourRequests: 0,
    totalTokens: 0,
    todayTokens: 0,
    hourTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastUsed: null,
  };
}

export function getApiKeyUsageSummaries(apiKeyIds: string[]): Record<string, ApiKeyUsageSummary> {
  const ids = Array.from(
    new Set(apiKeyIds.filter((id): id is string => typeof id === "string" && id.trim() !== ""))
  );
  const summaries = Object.fromEntries(ids.map((id) => [id, emptySummary()]));
  if (ids.length === 0) return summaries;

  const window = getBangkokUsageWindow();
  const placeholders = ids.map((_, index) => `@id${index}`).join(", ");
  const params = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        api_key_id as apiKeyId,
        COUNT(*) as totalRequests,
        COALESCE(SUM(CASE WHEN timestamp >= @todayStart THEN 1 ELSE 0 END), 0) as todayRequests,
        COALESCE(SUM(CASE WHEN timestamp >= @hourStart THEN 1 ELSE 0 END), 0) as hourRequests,
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(SUM(CASE WHEN timestamp >= @todayStart THEN tokens_input + tokens_output ELSE 0 END), 0) as todayTokens,
        COALESCE(SUM(CASE WHEN timestamp >= @hourStart THEN tokens_input + tokens_output ELSE 0 END), 0) as hourTokens,
        MAX(timestamp) as lastUsed
      FROM usage_history
      WHERE api_key_id IN (${placeholders})
      GROUP BY api_key_id
    `
    )
    .all({ ...params, todayStart: window.startIso, hourStart: window.hourStartIso }) as UsageRow[];

  for (const row of rows) {
    const apiKeyId = toStringOrNull(row.apiKeyId);
    if (!apiKeyId) continue;
    summaries[apiKeyId] = {
      totalRequests: toNumber(row.totalRequests),
      todayRequests: toNumber(row.todayRequests),
      hourRequests: toNumber(row.hourRequests),
      totalTokens: toNumber(row.totalTokens),
      todayTokens: toNumber(row.todayTokens),
      hourTokens: toNumber(row.hourTokens),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      lastUsed: toStringOrNull(row.lastUsed),
    };
  }

  return summaries;
}

export function getApiKeyModelUsage(apiKeyId: string, limit = 20): ApiKeyModelUsage[] {
  if (!apiKeyId) return [];
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        COALESCE(NULLIF(model, ''), 'unknown') as model,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        MAX(timestamp) as lastUsed
      FROM usage_history
      WHERE api_key_id = @apiKeyId
      GROUP BY COALESCE(NULLIF(model, ''), 'unknown')
      ORDER BY totalTokens DESC, requests DESC
      LIMIT @limit
    `
    )
    .all({ apiKeyId, limit: safeLimit }) as UsageRow[];

  return rows.map((row) => ({
    model: toStringOrNull(row.model) || "unknown",
    requests: toNumber(row.requests),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    totalTokens: toNumber(row.totalTokens),
    lastUsed: toStringOrNull(row.lastUsed),
  }));
}
