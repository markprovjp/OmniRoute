import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import {
  getCachedProviderLimitsMap,
  getLastProviderLimitsAutoSyncTime,
  getProviderLimitsSyncIntervalMinutes,
  syncAllProviderLimits,
} from "@/lib/usage/providerLimits";

async function getActiveProviderLimitsCache() {
  const [connections, allCaches] = await Promise.all([
    getProviderConnections({ isActive: true }),
    Promise.resolve(getCachedProviderLimitsMap()),
  ]);
  const activeIds = new Set(connections.map((connection) => connection.id));
  return Object.fromEntries(
    Object.entries(allCaches).filter(([connectionId]) => activeIds.has(connectionId))
  );
}

/**
 * GET /api/usage/provider-limits
 * Returns cached Provider Limits data without triggering live refreshes.
 */
export async function GET() {
  try {
    return NextResponse.json({
      caches: await getActiveProviderLimitsCache(),
      intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    console.error("[API] GET /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to fetch cached provider limits" }, { status: 500 });
  }
}

/**
 * POST /api/usage/provider-limits
 * Manually refresh all supported Provider Limits entries.
 */
export async function POST() {
  try {
    const result = await syncAllProviderLimits({ source: "manual" });
    const caches = await getActiveProviderLimitsCache();
    return NextResponse.json({
      ...result,
      caches,
      intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    console.error("[API] POST /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to refresh provider limits" }, { status: 500 });
  }
}
