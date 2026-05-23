import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { maskStoredApiKey } from "@/lib/apiKeyExposure";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import {
  getApiKeyModelUsage,
  getApiKeyUsageSummaries,
  getBangkokUsageWindow,
} from "@/lib/usage/apiKeyUsageSummary";
import { getApiKeyQuotaSnapshot } from "@/lib/usage/apiKeyQuotaLedger";

function toNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function keyState(apiKey: { isActive?: boolean; isBanned?: boolean; expiresAt?: string | null }) {
  if (apiKey.isBanned === true) return "banned";
  if (apiKey.isActive === false) return "disabled";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function serializeModels(rows: ReturnType<typeof getApiKeyModelUsage>) {
  return rows.map((row) => ({
    model: row.model,
    requests: row.requests,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    total_tokens: row.totalTokens,
    last_used_at: row.lastUsed,
  }));
}

export async function OPTIONS() {
  return handleCorsOptions();
}

async function readUsageKey(request: Request): Promise<string | null> {
  const bearer = extractApiKey(request);
  if (bearer) return bearer;
  if (request.method !== "POST") return null;

  try {
    const body = (await request.json()) as { key?: unknown; apiKey?: unknown };
    const bodyKey = typeof body.apiKey === "string" ? body.apiKey : body.key;
    return typeof bodyKey === "string" && bodyKey.trim() ? bodyKey.trim() : null;
  } catch {
    return null;
  }
}

async function getUsageResponse(request: Request) {
  const rawKey = await readUsageKey(request);
  if (!rawKey) {
    return NextResponse.json(
      { error: "Missing bearer API key" },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const apiKey = await getApiKeyMetadata(rawKey);
  if (!apiKey) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: CORS_HEADERS });
  }

  const window = getBangkokUsageWindow();
  const measured = getApiKeyUsageSummaries([apiKey.id])[apiKey.id];
  const quota = getApiKeyQuotaSnapshot(apiKey.id);
  const models = getApiKeyModelUsage(apiKey.id);
  const requestsToday = quota.day?.requestCount ?? measured.todayRequests;
  const totalTokens = Math.max(measured.totalTokens, toNumber(apiKey.tokenUsed));
  const requestLimit = toNumber(apiKey.maxRequestsPerDay) || null;
  const tokenLimit = toNumber(apiKey.tokenLimit) || null;
  const dailyTokenLimit = toNumber(apiKey.dailyTokenLimit) || quota.day?.tokenLimit || null;
  const hourlyTokenLimit = toNumber(apiKey.hourlyTokenLimit) || quota.hour?.tokenLimit || null;
  const requestsRemaining =
    requestLimit === null ? null : Math.max(0, requestLimit - requestsToday);
  const tokensRemaining = tokenLimit === null ? null : Math.max(0, tokenLimit - totalTokens);
  const serializedModels = serializeModels(models);

  return NextResponse.json(
    {
      success: true,
      checkedAt: new Date().toISOString(),
      object: "api_key_usage",
      key: {
        name: apiKey.name || "API key",
        prefix: maskStoredApiKey(rawKey),
        state: keyState(apiKey),
        expires_at: apiKey.expiresAt || null,
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
      models: serializedModels,
    },
    { headers: CORS_HEADERS }
  );
}

export async function GET(request: Request) {
  return getUsageResponse(request);
}

export async function POST(request: Request) {
  return getUsageResponse(request);
}
