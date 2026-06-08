-- Persist OAuth expired-token retry backoff state.
--
-- tokenHealthCheck.ts increments these fields for expired connections so the
-- scheduler can honor exponential backoff and stop after EXPIRED_RETRY_MAX.

ALTER TABLE provider_connections ADD COLUMN expired_retry_count INTEGER;
ALTER TABLE provider_connections ADD COLUMN expired_retry_at TEXT;
