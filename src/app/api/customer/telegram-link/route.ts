import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { issueTelegramLinkClaim } from "@/lib/telegramTokenBot/linkClaims";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";

const MAX_CUSTOMER_API_KEY_LENGTH = 1024;
const NO_STORE_HEADERS = { ...CORS_HEADERS, "Cache-Control": "no-store" };

type TelegramLinkBody = {
  apiKey?: unknown;
  key?: unknown;
};

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function isEligibleForTelegramLink(
  apiKey: NonNullable<Awaited<ReturnType<typeof getApiKeyMetadata>>>
) {
  if (!apiKey.isActive || apiKey.isBanned || apiKey.revokedAt) return false;
  if (!apiKey.expiresAt) return true;

  const expiresAt = Date.parse(apiKey.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function readCustomerApiKey(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as TelegramLinkBody | null;
    const bodyKey = typeof body?.apiKey === "string" ? body.apiKey : body?.key;
    if (typeof bodyKey !== "string") return null;

    const rawKey = bodyKey.trim();
    return rawKey.length > 0 && rawKey.length <= MAX_CUSTOMER_API_KEY_LENGTH ? rawKey : null;
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  try {
    const rawKey = await readCustomerApiKey(request);
    if (!rawKey) return response({ error: "Unauthorized" }, 401);

    const apiKey = await getApiKeyMetadata(rawKey);
    if (!apiKey) return response({ error: "Unauthorized" }, 401);
    if (!isEligibleForTelegramLink(apiKey)) return response({ error: "Forbidden" }, 403);

    const claim = issueTelegramLinkClaim(apiKey.id);
    return response({ success: true, ...claim }, 200);
  } catch {
    return response({ error: "Unable to issue Telegram link" }, 500);
  }
}
