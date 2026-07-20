-- Reconcile legacy API-key token counters that charged cached Codex input tokens.
--
-- Safety gate: only change a key when its current token_used exactly equals the
-- complete successful usage_history raw total and it has no modern quota-ledger
-- rows. Ambiguous/imported counters are intentionally left untouched.

CREATE TABLE IF NOT EXISTS api_key_token_reconciliation_audit (
  id TEXT PRIMARY KEY,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  api_key_name TEXT NOT NULL,
  previous_token_used INTEGER NOT NULL,
  corrected_token_used INTEGER NOT NULL,
  excluded_cached_tokens INTEGER NOT NULL,
  usage_rows INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_token_reconciliation_key
  ON api_key_token_reconciliation_audit(api_key_id, created_at DESC);

WITH evidence AS (
  SELECT
    api_key_id,
    COUNT(*) AS usage_rows,
    CAST(SUM(tokens_input + tokens_output) AS INTEGER) AS raw_total,
    CAST(SUM(
      MAX(
        0,
        tokens_input - COALESCE(tokens_cache_read, 0) - COALESCE(tokens_cache_creation, 0)
      ) + tokens_output
    ) AS INTEGER) AS corrected_total
  FROM usage_history
  WHERE api_key_id IS NOT NULL
    AND success = 1
  GROUP BY api_key_id
)
INSERT OR IGNORE INTO api_key_token_reconciliation_audit (
  id,
  api_key_id,
  api_key_name,
  previous_token_used,
  corrected_token_used,
  excluded_cached_tokens,
  usage_rows,
  reason,
  created_at
)
SELECT
  '071:' || keys.id,
  keys.id,
  keys.name,
  keys.token_used,
  evidence.corrected_total,
  evidence.raw_total - evidence.corrected_total,
  evidence.usage_rows,
  'legacy_cached_input_overcount',
  datetime('now')
FROM api_keys AS keys
JOIN evidence ON evidence.api_key_id = keys.id
WHERE evidence.usage_rows > 0
  AND evidence.corrected_total < evidence.raw_total
  AND keys.token_used = evidence.raw_total
  AND NOT EXISTS (
    SELECT 1
    FROM api_key_usage_ledger AS ledger
    WHERE ledger.api_key_id = keys.id
  );

UPDATE api_keys
SET token_used = (
  SELECT audit.corrected_token_used
  FROM api_key_token_reconciliation_audit AS audit
  WHERE audit.id = '071:' || api_keys.id
)
WHERE EXISTS (
  SELECT 1
  FROM api_key_token_reconciliation_audit AS audit
  WHERE audit.id = '071:' || api_keys.id
    AND api_keys.token_used = audit.previous_token_used
);
