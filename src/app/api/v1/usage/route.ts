import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { buildApiKeyCustomerUsage } from "@/lib/usage/apiKeyCustomerUsage";

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

  const usage = await buildApiKeyCustomerUsage(apiKey, { rawKeyForMasking: rawKey });
  return NextResponse.json(usage, { headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  return getUsageResponse(request);
}

export async function POST(request: Request) {
  return getUsageResponse(request);
}
