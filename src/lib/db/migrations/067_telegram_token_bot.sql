CREATE TABLE IF NOT EXISTS telegram_link_claims (
  token_hash TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_claims_expires_at
  ON telegram_link_claims(expires_at);

CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  muted_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_subscriptions_active
  ON telegram_subscriptions(is_active, muted_until);

CREATE TABLE IF NOT EXISTS telegram_alert_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  telegram_message_id TEXT,
  error_message TEXT,
  retry_at INTEGER,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subscription_id, dedupe_key),
  FOREIGN KEY (subscription_id) REFERENCES telegram_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_alert_deliveries_retry
  ON telegram_alert_deliveries(retry_at);

CREATE TABLE IF NOT EXISTS telegram_bot_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
