CREATE INDEX IF NOT EXISTS idx_cl_api_key_timestamp
  ON call_logs(api_key_id, timestamp DESC);
