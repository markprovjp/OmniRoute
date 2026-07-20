import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getDbInstance } from "@/lib/db/core";
import { getNonCachedInputTokens } from "./tokenAccounting";

type RequestLogRow = {
  id: string;
  timestamp: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  model: string | null;
  requested_model: string | null;
  provider: string | null;
  duration: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  tokens_reasoning: number | null;
  tokens_compressed: number | null;
  cache_source: string | null;
  request_type: string | null;
  source_format: string | null;
  target_format: string | null;
  error_summary: string | null;
  provider_node_prefix: string | null;
};

export type ApiKeyRequestLogStatus = "all" | "success" | "error";

export interface ApiKeyRequestLog {
  id: string;
  timestamp: string | null;
  method: string | null;
  path: string | null;
  status: number;
  outcome: "success" | "error";
  model: string;
  requestedModel: string | null;
  requestType: string | null;
  durationMs: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    reasoning: number | null;
    compressed: number | null;
    total: number;
  };
  cacheSource: string;
  sourceFormat: string | null;
  targetFormat: string | null;
  error: string | null;
}

export interface ApiKeyRequestLogSummary {
  returned: number;
  errors: number;
  averageLatencyMs: number | null;
}

export interface ApiKeyRequestLogPage {
  logs: ApiKeyRequestLog[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: ApiKeyRequestLogSummary;
}

function toNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeApiKeyRequestLogStatus(value: unknown): ApiKeyRequestLogStatus {
  return value === "success" || value === "error" ? value : "all";
}

export function normalizeApiKeyRequestLogLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

function isCompatibleProviderId(providerId: string | null): boolean {
  return Boolean(
    providerId &&
    (providerId.startsWith("openai-compatible-") || providerId.startsWith("anthropic-compatible-"))
  );
}

function applyNodePrefix(
  requestedModel: string | null,
  provider: string | null,
  nodePrefix: string | null
): string | null {
  if (!requestedModel || !provider || !nodePrefix || !isCompatibleProviderId(provider)) {
    return requestedModel;
  }
  if (requestedModel.startsWith(provider + "/")) {
    return nodePrefix + "/" + requestedModel.slice(provider.length + 1);
  }
  return requestedModel;
}

function sanitizeCustomerError(value: string | null): string | null {
  if (!value) return null;
  const sanitized = sanitizeErrorMessage(value);
  if (!sanitized) return null;
  return sanitized.length > 500 ? sanitized.slice(0, 500) : sanitized;
}

function mapRequestLogRow(row: RequestLogRow): ApiKeyRequestLog {
  const status = toNumber(row.status);
  const hasError = status >= 400 || Boolean(row.error_summary);
  const requestedModel = applyNodePrefix(
    toStringOrNull(row.requested_model),
    toStringOrNull(row.provider),
    toStringOrNull(row.provider_node_prefix)
  );
  const rawInput = toNumber(row.tokens_in);
  const output = toNumber(row.tokens_out);
  const cacheRead = toNullableNumber(row.tokens_cache_read);
  const cacheWrite = toNullableNumber(row.tokens_cache_creation);
  const input = getNonCachedInputTokens({
    input: rawInput,
    cacheRead: cacheRead ?? 0,
    cacheCreation: cacheWrite ?? 0,
  });
  const reasoning = toNullableNumber(row.tokens_reasoning);
  const compressed = toNullableNumber(row.tokens_compressed);

  return {
    id: row.id,
    timestamp: row.timestamp,
    method: toStringOrNull(row.method),
    path: toStringOrNull(row.path),
    status,
    outcome: hasError ? "error" : "success",
    model: requestedModel || toStringOrNull(row.model) || "unknown",
    requestedModel,
    requestType: toStringOrNull(row.request_type),
    durationMs: toNumber(row.duration),
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      compressed,
      total: input + output,
    },
    cacheSource: toStringOrNull(row.cache_source) || "upstream",
    sourceFormat: toStringOrNull(row.source_format),
    targetFormat: toStringOrNull(row.target_format),
    error: sanitizeCustomerError(row.error_summary),
  };
}

export function summarizeApiKeyRequestLogs(logs: ApiKeyRequestLog[]): ApiKeyRequestLogSummary {
  if (logs.length === 0) {
    return { returned: 0, errors: 0, averageLatencyMs: null };
  }

  const totalLatency = logs.reduce((sum, log) => sum + log.durationMs, 0);
  return {
    returned: logs.length,
    errors: logs.filter((log) => log.outcome === "error").length,
    averageLatencyMs: Math.round(totalLatency / logs.length),
  };
}

function requestLogFilter(apiKeyId: string, status: ApiKeyRequestLogStatus) {
  const conditions = ["cl.api_key_id = @apiKeyId"];
  if (status === "success") {
    conditions.push("cl.status >= 200 AND cl.status < 400 AND cl.error_summary IS NULL");
  } else if (status === "error") {
    conditions.push("(cl.status >= 400 OR cl.error_summary IS NOT NULL)");
  }
  return { conditions, params: { apiKeyId } };
}

export function getApiKeyRequestLogs({
  apiKeyId,
  limit,
  status,
  offset = 0,
}: {
  apiKeyId: string;
  limit?: number;
  status?: ApiKeyRequestLogStatus;
  offset?: number;
}): ApiKeyRequestLog[] {
  if (!apiKeyId) return [];

  const safeLimit = normalizeApiKeyRequestLogLimit(limit);
  const safeStatus = normalizeApiKeyRequestLogStatus(status);
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const { conditions, params } = requestLogFilter(apiKeyId, safeStatus);
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        cl.id,
        cl.timestamp,
        cl.method,
        cl.path,
        cl.status,
        cl.model,
        cl.requested_model,
        cl.provider,
        cl.duration,
        cl.tokens_in,
        cl.tokens_out,
        cl.tokens_cache_read,
        cl.tokens_cache_creation,
        cl.tokens_reasoning,
        cl.tokens_compressed,
        cl.cache_source,
        cl.request_type,
        cl.source_format,
        cl.target_format,
        cl.error_summary,
        pn.prefix AS provider_node_prefix
      FROM call_logs cl
      LEFT JOIN provider_nodes pn ON pn.id = cl.provider
      WHERE ${conditions.join(" AND ")}
      ORDER BY cl.timestamp DESC
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ ...params, limit: safeLimit, offset: safeOffset }) as RequestLogRow[];

  return rows.map(mapRequestLogRow);
}

export function getApiKeyRequestLogPage({
  apiKeyId,
  page = 1,
  pageSize = 10,
  status,
}: {
  apiKeyId: string;
  page?: number;
  pageSize?: number;
  status?: ApiKeyRequestLogStatus;
}): ApiKeyRequestLogPage {
  const safePageSize = Math.min(25, normalizeApiKeyRequestLogLimit(pageSize));
  const safeStatus = normalizeApiKeyRequestLogStatus(status);
  if (!apiKeyId) {
    return {
      logs: [],
      page: 1,
      pageSize: safePageSize,
      total: 0,
      totalPages: 1,
      summary: summarizeApiKeyRequestLogs([]),
    };
  }

  const { conditions, params } = requestLogFilter(apiKeyId, safeStatus);
  const countRow = getDbInstance()
    .prepare(`SELECT COUNT(*) AS total FROM call_logs cl WHERE ${conditions.join(" AND ")}`)
    .get(params) as { total?: number } | undefined;
  const total = toNumber(countRow?.total);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
  const safePage = Math.min(requestedPage, totalPages);
  const logs = getApiKeyRequestLogs({
    apiKeyId,
    limit: safePageSize,
    status: safeStatus,
    offset: (safePage - 1) * safePageSize,
  });

  return {
    logs,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages,
    summary: summarizeApiKeyRequestLogs(logs),
  };
}
