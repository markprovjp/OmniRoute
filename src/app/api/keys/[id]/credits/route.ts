import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createApiKeyCredit,
  getApiKeyById,
  getApiKeyCreditSummary,
  isCloudEnabled,
  listApiKeyCredits,
} from "@/lib/localDb";
import { syncToCloud } from "@/lib/cloudSync";
import { isPrepaidTokenPackage, TEST_TOKEN_CREDIT } from "@/shared/constants/apiKeyBilling";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import * as log from "@/sse/utils/logger";

const creditSchema = z
  .object({
    tokenAmount: z
      .number()
      .int()
      .positive()
      .refine(isPrepaidTokenPackage, "Unsupported token package"),
    amountDueVnd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    paymentStatus: z.enum(["unpaid", "paid"]).default("unpaid"),
    applyTokens: z.boolean().default(true),
    kind: z.enum(["top_up", "test_credit"]).default("top_up"),
    note: z.string().trim().max(500).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

function invalidRequest(details: unknown) {
  return NextResponse.json({ error: { message: "Invalid request", details } }, { status: 400 });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    return NextResponse.json({
      credits: listApiKeyCredits(id),
      summary: getApiKeyCreditSummary(id),
    });
  } catch (error) {
    log.error("keys", "Error listing API key credit ledger", error);
    return NextResponse.json({ error: "Failed to list token credits" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest([{ field: "body", message: "Invalid JSON body" }]);
  }

  const validation = creditSchema.safeParse(body);
  if (!validation.success) return invalidRequest(validation.error.issues);

  try {
    const { id } = await params;
    const data = validation.data;
    const kind = data.tokenAmount === TEST_TOKEN_CREDIT ? "test_credit" : data.kind;
    if (kind === "test_credit" && data.tokenAmount !== TEST_TOKEN_CREDIT) {
      return invalidRequest([
        { field: "tokenAmount", message: "Test credit must be exactly 15,000,000 tokens" },
      ]);
    }

    const result = createApiKeyCredit(id, {
      ...data,
      kind,
      amountDueVnd: kind === "test_credit" ? 0 : data.amountDueVnd,
      paymentStatus: kind === "test_credit" ? "paid" : data.paymentStatus,
    });
    if (!result) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    await syncKeyLimitToCloudIfEnabled();
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    log.error("keys", "Error creating API key token credit", error);
    return NextResponse.json({ error: "Failed to record token credit" }, { status: 500 });
  }
}

async function syncKeyLimitToCloudIfEnabled() {
  try {
    if (!(await isCloudEnabled())) return;
    await syncToCloud(await getConsistentMachineId());
  } catch (error) {
    log.error("keys", "Error syncing token credit limit to cloud", error);
  }
}
