CREATE TABLE IF NOT EXISTS image_generation_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  api_key_id TEXT,
  api_key_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('generation', 'edit')),
  provider TEXT,
  model TEXT NOT NULL,
  connection_id TEXT,
  requested_count INTEGER NOT NULL DEFAULT 1,
  generated_count INTEGER NOT NULL DEFAULT 0,
  size TEXT,
  quality TEXT,
  output_format TEXT,
  prompt_sha256 TEXT,
  prompt_length INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rejected', 'expired')),
  http_status INTEGER,
  error_code TEXT,
  upstream_request_id TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_image_events_key_created
  ON image_generation_events(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_events_status_created
  ON image_generation_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_events_created
  ON image_generation_events(created_at DESC);
