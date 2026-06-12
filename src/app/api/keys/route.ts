import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, isCloudEnabled, updateApiKeyPermissions } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { createKeySchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { isApiKeyRevealEnabled, maskStoredApiKey } from "@/lib/apiKeyExposure";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyUsageSummaries } from "@/lib/usage/apiKeyUsageSummary";
import { getApiKeyQuotaSnapshots } from "@/lib/usage/apiKeyQuotaLedger";
import * as log from "@/sse/utils/logger";

function parsePagination(request: Request) {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const offsetValue = url.searchParams.get("offset");

  const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  const parsedOffset = offsetValue ? Number.parseInt(offsetValue, 10) : 0;

  const limit =
    Number.isInteger(parsedLimit) && parsedLimit && parsedLimit > 0 ? parsedLimit : null;
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  return { limit, offset };
}

// GET /api/keys - List API keys
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const keys = await getApiKeys();
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskStoredApiKey(k.key),
    }));
    const { limit, offset } = parsePagination(request);
    const pagedKeys =
      limit === null ? maskedKeys.slice(offset) : maskedKeys.slice(offset, offset + limit);
    const usageByKeyId = getApiKeyUsageSummaries(
      pagedKeys.map((key) => (typeof key.id === "string" ? key.id : ""))
    );
    const quotaByKeyId = getApiKeyQuotaSnapshots(
      pagedKeys.map((key) => (typeof key.id === "string" ? key.id : ""))
    );

    return NextResponse.json({
      keys: pagedKeys.map((key) => ({
        ...key,
        usage: usageByKeyId[String(key.id)],
        quota: quotaByKeyId[String(key.id)],
      })),
      total: maskedKeys.length,
      allowKeyReveal: isApiKeyRevealEnabled(),
    });
  } catch (error) {
    log.error("keys", "Error fetching keys", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    // Zod validation
    const validation = validateBody(createKeySchema, body);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      name,
      billingMode,
      noLog,
      scopes,
      customerName,
      internalNote,
      tokenLimit,
      dailyTokenLimit,
      hourlyTokenLimit,
      maxRequestsPerDay,
      maxRequestsPerMinute,
      expiresAt,
    } = validation.data;

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const isSystemKey = billingMode === "system";
    const apiKey = await createApiKey(name, machineId, {
      scopes: scopes ?? [],
      customerName: customerName ?? name,
      internalNote: internalNote ?? null,
      tokenLimit: isSystemKey ? null : (tokenLimit ?? null),
      dailyTokenLimit: dailyTokenLimit ?? null,
      hourlyTokenLimit: hourlyTokenLimit ?? null,
      maxRequestsPerDay: maxRequestsPerDay ?? null,
      maxRequestsPerMinute: maxRequestsPerMinute ?? null,
      expiresAt: expiresAt ?? null,
      commercialKey: !isSystemKey,
    });
    if (noLog === true) {
      await updateApiKeyPermissions(apiKey.id, { noLog: true });
    }
    if (maxRequestsPerDay !== undefined || maxRequestsPerMinute !== undefined) {
      await updateApiKeyPermissions(apiKey.id, {
        maxRequestsPerDay: maxRequestsPerDay ?? null,
        maxRequestsPerMinute: maxRequestsPerMinute ?? null,
      });
    }

    // Auto sync to Cloud if enabled
    await syncKeysToCloudIfEnabled();

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
        noLog: noLog === true,
        customerName: apiKey.customerName,
        internalNote: apiKey.internalNote,
        tokenLimit: apiKey.tokenLimit,
        dailyTokenLimit: apiKey.dailyTokenLimit,
        hourlyTokenLimit: apiKey.hourlyTokenLimit,
        tokenUsed: apiKey.tokenUsed,
        commercialKey: apiKey.commercialKey,
        maxRequestsPerDay: maxRequestsPerDay ?? null,
        maxRequestsPerMinute: maxRequestsPerMinute ?? null,
        expiresAt: apiKey.expiresAt,
      },
      { status: 201 }
    );
  } catch (error) {
    log.error("keys", "Error creating key", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}

/**
 * Sync API keys to Cloud if enabled
 */
async function syncKeysToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    log.error("keys", "Error syncing keys to cloud", error);
  }
}
