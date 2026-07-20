-- Durable token top-up and VND receivables ledger for managed API keys.
-- Financial history is preserved after a key is deleted through snapshots and ON DELETE SET NULL.

CREATE TABLE IF NOT EXISTS api_key_credit_ledger (
  id TEXT PRIMARY KEY,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  api_key_name TEXT NOT NULL,
  customer_name TEXT,
  token_amount INTEGER NOT NULL CHECK (token_amount > 0),
  amount_due_vnd INTEGER NOT NULL DEFAULT 0 CHECK (amount_due_vnd >= 0),
  amount_paid_vnd INTEGER NOT NULL DEFAULT 0 CHECK (
    amount_paid_vnd >= 0 AND amount_paid_vnd <= amount_due_vnd
  ),
  kind TEXT NOT NULL DEFAULT 'top_up' CHECK (kind IN ('top_up', 'test_credit')),
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (
    status IN ('unpaid', 'partial', 'paid', 'waived')
  ),
  applied_tokens INTEGER NOT NULL DEFAULT 1 CHECK (applied_tokens IN (0, 1)),
  note TEXT,
  due_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_credit_ledger_key_created
  ON api_key_credit_ledger(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_credit_ledger_status_due
  ON api_key_credit_ledger(status, due_at);
