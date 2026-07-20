import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { markApiKeyCreditPaid } from "@/lib/localDb";
import * as log from "@/sse/utils/logger";

const paymentSchema = z.object({ action: z.literal("mark_paid") }).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; creditId: string }> }
) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid request" } }, { status: 400 });
  }
  const validation = paymentSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: { message: "Invalid request", details: validation.error.issues } },
      { status: 400 }
    );
  }

  try {
    const { id, creditId } = await params;
    const result = markApiKeyCreditPaid(id, creditId);
    if (!result) return NextResponse.json({ error: "Credit entry not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    log.error("keys", "Error marking API key debt as paid", error);
    return NextResponse.json({ error: "Failed to clear debt" }, { status: 500 });
  }
}
