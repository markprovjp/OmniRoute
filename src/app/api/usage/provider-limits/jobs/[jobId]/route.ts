import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderLimitsRefreshJob } from "@/lib/usage/providerLimitsRefreshJobs";
import * as log from "@/sse/utils/logger";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function parseCursor(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get("after");
  if (raw === null || raw === "") return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Return only progress updates newer than the supplied cursor. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const after = parseCursor(request);
  if (after === null) {
    return NextResponse.json(
      { error: "after must be a non-negative safe integer" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const { jobId } = await params;
    const result = getProviderLimitsRefreshJob(jobId, after);
    if (!result) {
      return NextResponse.json(
        { error: "Provider limits refresh job not found" },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    log.error(
      "PROVIDER_LIMITS",
      `Failed to read refresh job (${error instanceof Error ? error.name : "unknown"})`
    );
    return NextResponse.json(
      { error: "Failed to read provider limits refresh job" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
