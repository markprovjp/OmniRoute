import { randomUUID } from "node:crypto";
import { getDbInstance, rowToCamel } from "./core";
import { clearApiKeyCaches } from "./apiKeys";

export type ApiKeyCreditKind = "top_up" | "test_credit";
export type ApiKeyCreditStatus = "unpaid" | "partial" | "paid" | "waived";

export interface ApiKeyCreditEntry {
  id: string;
  apiKeyId: string | null;
  apiKeyName: string;
  customerName: string | null;
  tokenAmount: number;
  amountDueVnd: number;
  amountPaidVnd: number;
  outstandingAmountVnd: number;
  kind: ApiKeyCreditKind;
  status: ApiKeyCreditStatus;
  appliedTokens: boolean;
  note: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyCreditSummary {
  outstandingAmountVnd: number;
  outstandingTokenAmount: number;
  openEntryCount: number;
  totalCreditedTokens: number;
}

export interface CreateApiKeyCreditInput {
  tokenAmount: number;
  amountDueVnd: number;
  paymentStatus: "unpaid" | "paid";
  applyTokens: boolean;
  kind?: ApiKeyCreditKind;
  note?: string | null;
  dueAt?: string | null;
}

interface ApiKeySnapshotRow {
  id: string;
  name: string;
  customer_name: string | null;
  token_limit: number | null;
  token_used: number | null;
}

function toCreditEntry(row: Record<string, unknown>): ApiKeyCreditEntry {
  const entry = rowToCamel(row) as unknown as Omit<
    ApiKeyCreditEntry,
    "appliedTokens" | "outstandingAmountVnd"
  > & { appliedTokens: number };
  return {
    ...entry,
    appliedTokens: entry.appliedTokens === 1,
    outstandingAmountVnd: Math.max(0, entry.amountDueVnd - entry.amountPaidVnd),
  };
}

function emptySummary(): ApiKeyCreditSummary {
  return {
    outstandingAmountVnd: 0,
    outstandingTokenAmount: 0,
    openEntryCount: 0,
    totalCreditedTokens: 0,
  };
}

export function getApiKeyCreditSummary(apiKeyId: string): ApiKeyCreditSummary {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial')
           THEN amount_due_vnd - amount_paid_vnd ELSE 0 END), 0) AS outstandingAmountVnd,
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial')
           THEN token_amount ELSE 0 END), 0) AS outstandingTokenAmount,
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial') THEN 1 ELSE 0 END), 0)
           AS openEntryCount,
         COALESCE(SUM(token_amount), 0) AS totalCreditedTokens
       FROM api_key_credit_ledger
       WHERE api_key_id = ?`
    )
    .get(apiKeyId) as ApiKeyCreditSummary | undefined;
  return row || emptySummary();
}

export function getApiKeyCreditSummaries(apiKeyIds: string[]): Record<string, ApiKeyCreditSummary> {
  const ids = [...new Set(apiKeyIds.filter(Boolean))];
  const summaries = Object.fromEntries(ids.map((id) => [id, emptySummary()]));
  if (ids.length === 0) return summaries;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = getDbInstance()
    .prepare(
      `SELECT
         api_key_id AS apiKeyId,
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial')
           THEN amount_due_vnd - amount_paid_vnd ELSE 0 END), 0) AS outstandingAmountVnd,
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial')
           THEN token_amount ELSE 0 END), 0) AS outstandingTokenAmount,
         COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partial') THEN 1 ELSE 0 END), 0)
           AS openEntryCount,
         COALESCE(SUM(token_amount), 0) AS totalCreditedTokens
       FROM api_key_credit_ledger
       WHERE api_key_id IN (${placeholders})
       GROUP BY api_key_id`
    )
    .all(...ids) as Array<ApiKeyCreditSummary & { apiKeyId: string }>;

  for (const row of rows) {
    const { apiKeyId, ...summary } = row;
    summaries[apiKeyId] = summary;
  }
  return summaries;
}

export function listApiKeyCredits(apiKeyId: string): ApiKeyCreditEntry[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT * FROM api_key_credit_ledger
       WHERE api_key_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(apiKeyId) as Record<string, unknown>[];
  return rows.map(toCreditEntry);
}

export function createApiKeyCredit(
  apiKeyId: string,
  input: CreateApiKeyCreditInput
): { credit: ApiKeyCreditEntry; summary: ApiKeyCreditSummary; tokenLimit: number | null } | null {
  const db = getDbInstance();
  const create = db.transaction(() => {
    const key = db
      .prepare(
        `SELECT id, name, customer_name, token_limit, token_used
         FROM api_keys WHERE id = ?`
      )
      .get(apiKeyId) as ApiKeySnapshotRow | undefined;
    if (!key) return null;

    const kind: ApiKeyCreditKind = input.kind === "test_credit" ? "test_credit" : "top_up";
    const amountDueVnd = kind === "test_credit" ? 0 : input.amountDueVnd;
    const status: ApiKeyCreditStatus =
      kind === "test_credit" || amountDueVnd === 0
        ? "waived"
        : input.paymentStatus === "paid"
          ? "paid"
          : "unpaid";
    const amountPaidVnd = status === "paid" ? amountDueVnd : 0;
    const now = new Date().toISOString();
    const id = randomUUID();
    let tokenLimit = key.token_limit;

    if (input.applyTokens) {
      tokenLimit = Math.max(key.token_limit || 0, key.token_used || 0) + input.tokenAmount;
      db.prepare("UPDATE api_keys SET token_limit = ?, commercial_key = 1 WHERE id = ?").run(
        tokenLimit,
        apiKeyId
      );
    }

    db.prepare(
      `INSERT INTO api_key_credit_ledger (
         id, api_key_id, api_key_name, customer_name, token_amount,
         amount_due_vnd, amount_paid_vnd, kind, status, applied_tokens,
         note, due_at, paid_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      apiKeyId,
      key.name,
      key.customer_name,
      input.tokenAmount,
      amountDueVnd,
      amountPaidVnd,
      kind,
      status,
      input.applyTokens ? 1 : 0,
      input.note || null,
      input.dueAt || null,
      status === "paid" ? now : null,
      now,
      now
    );

    const row = db.prepare("SELECT * FROM api_key_credit_ledger WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    return { credit: toCreditEntry(row), tokenLimit };
  });

  const result = create();
  if (!result) return null;
  clearApiKeyCaches();
  return { ...result, summary: getApiKeyCreditSummary(apiKeyId) };
}

export function markApiKeyCreditPaid(
  apiKeyId: string,
  creditId: string
): { credit: ApiKeyCreditEntry; summary: ApiKeyCreditSummary } | null {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE api_key_credit_ledger
       SET amount_paid_vnd = amount_due_vnd,
           status = CASE WHEN amount_due_vnd = 0 THEN 'waived' ELSE 'paid' END,
           paid_at = CASE WHEN amount_due_vnd = 0 THEN paid_at ELSE ? END,
           updated_at = ?
       WHERE id = ? AND api_key_id = ?`
    )
    .run(now, now, creditId, apiKeyId);
  if (result.changes !== 1) return null;

  const row = db
    .prepare("SELECT * FROM api_key_credit_ledger WHERE id = ?")
    .get(creditId) as Record<string, unknown>;
  return { credit: toCreditEntry(row), summary: getApiKeyCreditSummary(apiKeyId) };
}
