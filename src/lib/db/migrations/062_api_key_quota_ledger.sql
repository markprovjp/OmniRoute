CREATE TABLE IF NOT EXISTS api_key_quota_windows (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('day', 'hour')),
  window_key TEXT NOT NULL,
  token_limit INTEGER,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  request_limit INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(api_key_id, window_type, window_key),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_key_usage_reservations (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  actual_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'expired')),
  usage_source TEXT,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_key_usage_reservation_windows (
  reservation_id TEXT NOT NULL,
  quota_window_id TEXT NOT NULL,
  PRIMARY KEY (reservation_id, quota_window_id),
  FOREIGN KEY (reservation_id) REFERENCES api_key_usage_reservations(id) ON DELETE CASCADE,
  FOREIGN KEY (quota_window_id) REFERENCES api_key_quota_windows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_key_usage_ledger (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  reservation_id TEXT,
  quota_window_id TEXT,
  request_id TEXT NOT NULL,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (reservation_id) REFERENCES api_key_usage_reservations(id) ON DELETE SET NULL,
  FOREIGN KEY (quota_window_id) REFERENCES api_key_quota_windows(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_quota_windows_key
  ON api_key_quota_windows(api_key_id, window_type, window_key);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_reservations_key_state
  ON api_key_usage_reservations(api_key_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_ledger_key_created
  ON api_key_usage_ledger(api_key_id, created_at DESC);
