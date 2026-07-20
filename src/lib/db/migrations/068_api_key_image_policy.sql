ALTER TABLE api_keys
  ADD COLUMN image_generation_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE api_keys
  ADD COLUMN image_max_requests_per_minute INTEGER NOT NULL DEFAULT 2;

ALTER TABLE api_keys
  ADD COLUMN image_max_requests_per_day INTEGER NOT NULL DEFAULT 10;

ALTER TABLE api_keys
  ADD COLUMN image_max_concurrent INTEGER NOT NULL DEFAULT 1;

ALTER TABLE api_keys
  ADD COLUMN image_allow_high_quality INTEGER NOT NULL DEFAULT 0;

ALTER TABLE api_keys
  ADD COLUMN image_allowed_sizes TEXT NOT NULL DEFAULT '["1024x1024","1536x1024","1024x1536"]';
