import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import {
  getApiKeyRequestLogs,
  normalizeApiKeyRequestLogLimit,
  normalizeApiKeyRequestLogStatus,
  summarizeApiKeyRequestLogs,
} from "@/lib/usage/apiKeyRequestLogs";
import { extractApiKey } from "@/sse/services/auth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

type CustomerLogsBody = {
  apiKey?: unknown;
  key?: unknown;
  limit?: unknown;
  status?: unknown;
};

export async function OPTIONS() {
  return handleCorsOptions();
}

async function readCustomerLogsRequest(request: Request) {
  const url = new URL(request.url);
  const bearer = extractApiKey(request);
  let body: CustomerLogsBody = {};

  if (request.method === "POST") {
    try {
      body = (await request.json()) as CustomerLogsBody;
    } catch {
      body = {};
    }
  }

  const bodyKey = typeof body.apiKey === "string" ? body.apiKey : body.key;
  const rawKey =
    bearer || (typeof bodyKey === "string" && bodyKey.trim().length > 0 ? bodyKey.trim() : null);
  const status = normalizeApiKeyRequestLogStatus(body.status ?? url.searchParams.get("status"));
  const limit = normalizeApiKeyRequestLogLimit(body.limit ?? url.searchParams.get("limit"));

  return { rawKey, status, limit };
}

async function getCustomerLogsResponse(request: Request) {
  const { rawKey, status, limit } = await readCustomerLogsRequest(request);
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

  const logs = getApiKeyRequestLogs({ apiKeyId: apiKey.id, status, limit });
  return NextResponse.json(
    {
      success: true,
      checkedAt: new Date().toISOString(),
      object: "api_key_request_logs",
      status,
      limit,
      logs,
      summary: summarizeApiKeyRequestLogs(logs),
    },
    { headers: CORS_HEADERS }
  );
}

export async function GET(request: Request) {
  try {
    return await getCustomerLogsResponse(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to read customer logs" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function POST(request: Request) {
  try {
    return await getCustomerLogsResponse(request);
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to read customer logs" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
