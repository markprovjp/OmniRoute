import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getActiveProviderLimitsRefreshJob,
  startProviderLimitsRefreshJob,
} from "@/lib/usage/providerLimitsRefreshJobs";
import * as log from "@/sse/utils/logger";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** Read the active all-account refresh job without starting a new one. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(
    { job: getActiveProviderLimitsRefreshJob() },
    { headers: NO_STORE_HEADERS }
  );
}

/** Start or join the active all-account Provider Limits refresh job. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const result = await startProviderLimitsRefreshJob("manual");
    return NextResponse.json(result, { status: 202, headers: NO_STORE_HEADERS });
  } catch (error) {
    log.error(
      "PROVIDER_LIMITS",
      `Failed to start refresh job (${error instanceof Error ? error.name : "unknown"})`
    );
    return NextResponse.json(
      { error: "Failed to start provider limits refresh" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
