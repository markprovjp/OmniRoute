# Secure Telegram Bot Patterns For OmniRoute API-Key Usage And Quota Monitoring

Date: 2026-07-19

## Investigation Question

What is the most secure and maintainable way to add a Telegram bot for API-key
usage/quota monitoring in OmniRoute, using primary-source evidence from the
official Telegram Bot API documentation and maintained open-source GitHub
sources?

## Decision Objective

Pick an implementation approach that:

- fits OmniRoute's existing quota and alerting model,
- avoids exposing customer API keys in Telegram,
- stays operationally simple on Node.js/TypeScript,
- is safe under long polling, retries, restarts, and duplicate updates,
- supports persistent chat subscriptions and scheduled alerts.

## Repo Context That Matters

OmniRoute already has the core monitoring primitives a Telegram bot should reuse:

- [`src/lib/usage/apiKeyQuotaLedger.ts`](../../src/lib/usage/apiKeyQuotaLedger.ts) enforces
  lifetime, daily, and hourly token/request quotas with reservation and settle
  flows.
- [`src/app/api/v1/usage/route.ts`](../../src/app/api/v1/usage/route.ts) exposes
  a read path that returns masked key metadata, token/request summaries, quota
  windows, and alert summaries.
- [`src/lib/usage/apiKeyAlerts.ts`](../../src/lib/usage/apiKeyAlerts.ts) already
  derives threshold alerts at 90/95/100 percent and dispatches `quota.exceeded`.
- [`src/lib/webhookDispatcher.ts`](../../src/lib/webhookDispatcher.ts) already
  provides signed event fan-out with retries.
- [`src/lib/db/migrations/062_api_key_quota_ledger.sql`](../../src/lib/db/migrations/062_api_key_quota_ledger.sql)
  already persists quota windows, reservations, and the usage ledger.

Conclusion from repo context: the bot should be a thin read/notification layer
over existing OmniRoute state, not a second quota engine.

## Primary-Source Findings

### 1. Telegram delivery semantics strongly support safe long polling

Official Bot API facts:

- `getUpdates` is the long-polling method, and `offset` must be greater than
  the highest previously received `update_id`; an update is confirmed when
  `getUpdates` is called with a higher offset.
  Source: https://core.telegram.org/bots/api#getupdates
- `deleteWebhook` is the supported way to switch from webhook delivery back to
  long polling.
  Source: https://core.telegram.org/bots/api#deletewebhook

Implication:

- A single active poller with persisted high-water offset is enough for
  idempotent intake.
- The bot does not need public ingress if OmniRoute only needs internal chat
  notifications and command handling.

Confidence: high.

### 2. Telegram commands and inline buttons are first-class, but callback payloads are tiny

Official Bot API facts:

- `setMyCommands` sets up to 100 commands for discovery and UX.
  Source: https://core.telegram.org/bots/api#setmycommands
- `InlineKeyboardButton.callback_data` is limited to 1-64 bytes.
  Source: https://core.telegram.org/bots/api#inlinekeyboardbutton

Implication:

- Use commands for primary navigation: `/start`, `/status`, `/watch`, `/unwatch`,
  `/alerts`, `/help`.
- Use inline buttons only with compact opaque identifiers or signed short tokens.
- Never embed raw API keys, full internal IDs, or verbose JSON in `callback_data`.

Confidence: high.

### 3. Webhooks can be secured, but they add avoidable ingress complexity for this use case

Official Bot API facts:

- `setWebhook` supports `secret_token`; Telegram then sends
  `X-Telegram-Bot-Api-Secret-Token`, limited to 1-256 chars and restricted to
  `[A-Za-z0-9_-]`.
  Source: https://core.telegram.org/bots/api#setwebhook

Open-source confirmation:

- Telegraf verifies webhook path and optional secret token in
  `src/telegraf.ts`, and passes `secret_token` to `setWebhook`.
  Source:
  https://github.com/telegraf/telegraf/blob/v4/src/telegraf.ts#L1139-L1158
  and
  https://github.com/telegraf/telegraf/blob/v4/src/telegraf.ts#L1423-L1460

Implication:

- Webhooks are safe when needed, but for OmniRoute's quota-monitoring bot they
  would add public routing, TLS, ingress filtering, and lifecycle drift without
  clear benefit over long polling.

Confidence: high.

## Open-Source Repository Evaluation

### A. `grammyjs/grammY`

Relevant source files:

- `src/bot.ts`
  https://github.com/grammyjs/grammY/blob/main/src/bot.ts#L2535-L2557
- `src/bot.ts`
  https://github.com/grammyjs/grammY/blob/main/src/bot.ts#L2741-L2780
- `src/bot.ts`
  https://github.com/grammyjs/grammY/blob/main/src/bot.ts#L2649-L2655

Observed facts:

- `bot.start()` initializes and starts simple long polling.
- The polling loop sends `allowed_updates` once, then omits it to save traffic.
- `bot.stop()` explicitly stops polling and preserves the update offset flow.

Assessment:

- Strong TypeScript fit for OmniRoute.
- Good default long-polling ergonomics.
- Clean library boundary for commands, callbacks, and middleware.

Tradeoff:

- Core polling is fine for moderate load, but concurrency control is more
  explicit when paired with `@grammyjs/runner`.

Confidence: high.

### B. `grammyjs/runner`

Relevant source files:

- `src/runner.ts`
  https://github.com/grammyjs/runner/blob/main/src/runner.ts#L1245-L1250
- `src/runner.ts`
  https://github.com/grammyjs/runner/blob/main/src/runner.ts#L1341-L1477
- `src/runner.ts`
  https://github.com/grammyjs/runner/blob/main/src/runner.ts#L1548-L1578
- `src/sequentialize.ts`
  https://github.com/grammyjs/runner/blob/main/src/sequentialize.ts#L452-L505

Observed facts:

- Runner is built for long polling with concurrent update handling.
- It automatically increments offset after successful fetches.
- It exposes `stop()` that interrupts pending `getUpdates` and can be awaited
  until running middleware finishes.
- `sequentialize` provides per-chat or per-user serialization and explicitly
  calls out session write-after-read hazards.

Assessment:

- Best evidence-backed fit for maintainable shutdown, concurrency, and
  idempotent update handling.
- Particularly useful if the bot stores per-chat subscription state or alert
  preferences.

Tradeoff:

- Slightly more moving pieces than bare polling, but the behavior is clearer and
  safer for stateful bots.

Confidence: high.

### C. `grammyjs/ratelimiter`

Relevant source files:

- `src/core/middleware.ts`
  https://github.com/grammyjs/ratelimiter/blob/main/src/core/middleware.ts#L431-L536
- `src/stores/redis.ts`
  https://github.com/grammyjs/ratelimiter/blob/main/src/stores/redis.ts#L620-L626

Observed facts:

- The limiter is keyed by a caller-provided `keyGenerator(ctx)`.
- It supports penalties, dynamic limits, `onLimitExceeded`, and pluggable
  storage.
- A Redis-backed store exists as a maintained backend.

Assessment:

- Good fit for per-chat and per-user throttling in a multi-instance or restart
  tolerant deployment.
- Redis storage matches OmniRoute's existing Redis-aware quota direction better
  than in-memory throttling.

Tradeoff:

- Extra dependency surface compared with a local in-memory throttle, but much
  safer if the bot can ever be scaled beyond one process.

Confidence: high.

### D. `telegraf/telegraf`

Relevant source files:

- `src/telegraf.ts`
  https://github.com/telegraf/telegraf/blob/v4/src/telegraf.ts#L1423-L1481
- `src/session.ts`
  https://github.com/telegraf/telegraf/blob/v4/src/session.ts#L728-L738
  and
  https://github.com/telegraf/telegraf/blob/v4/src/session.ts#L920-L940

Observed facts:

- `launch()` switches to long polling by first calling `deleteWebhook`.
- Webhook mode passes `secret_token`.
- `stop()` closes the webhook server and polling loop.
- Default session keys are `from.id:chat.id`, and the default session store is
  in-memory.

Assessment:

- Mature and workable.
- Good ergonomics if the team already prefers Telegraf.

Tradeoff:

- Session storage is memory-backed by default, so persistent subscriptions still
  need a separate durable store.
- Concurrency/session hazard handling is less explicit than grammY runner's
  `sequentialize` model.

Confidence: medium-high.

### E. `yagop/node-telegram-bot-api`

Relevant source files:

- `src/telegramPolling.js`
  https://github.com/yagop/node-telegram-bot-api/blob/master/src/telegramPolling.js#L821-L841
- `src/telegramPolling.js`
  https://github.com/yagop/node-telegram-bot-api/blob/master/src/telegramPolling.js#L800-L807

Observed facts:

- Polling updates `offset = update.update_id + 1` as it processes updates.
- Polling errors are surfaced through a `polling_error` event.

Assessment:

- Correct basic offset handling.
- Still viable for smaller bots.

Tradeoff:

- JS-first and less type-oriented than grammY or Telegraf.
- The event-driven error model is workable, but it gives less structure for a
  security-sensitive internal operations bot.

Confidence: medium.

### F. `0xfurai/gh-telegram-stars-bot`

Relevant source files:

- `src/services/polling.ts`
  https://github.com/0xfurai/gh-telegram-stars-bot/blob/main/src/services/polling.ts#L828-L926
- `src/services/polling.ts`
  https://github.com/0xfurai/gh-telegram-stars-bot/blob/main/src/services/polling.ts#L1052-L1205
- `src/services/database.ts`
  https://github.com/0xfurai/gh-telegram-stars-bot/blob/main/src/services/database.ts#L900-L1029

Observed facts:

- It guards scheduled polling with `isPolling` to prevent overlapping runs.
- It persists subscriptions in a join table (`chat_repositories`) and fans out
  notifications to subscribers.
- It schedules periodic checks with cron and stops the scheduled task cleanly.

Assessment:

- Useful real-world pattern for persistent subscriptions plus scheduled alert
  fan-out.
- The structure maps well to OmniRoute's alert thresholds and usage summaries.

Tradeoff:

- It stores its own polling domain model and notification logic; OmniRoute
  should reuse existing quota/alert data instead of duplicating business rules.

Confidence: medium-high.

## Pattern Synthesis By Concern

### Long polling vs webhook

Claim:

- Long polling is the better default for OmniRoute's first Telegram monitoring
  bot.

Evidence:

- Telegram's official `getUpdates` offset confirmation model is sufficient for
  reliable intake.
- grammY and Telegraf both support clean long-poll startup/shutdown.
- OmniRoute does not need public inbound Telegram traffic to monitor internal
  usage/quota state.

Confidence: high.

### Commands and buttons

Claim:

- Use commands for navigation and inline buttons only for compact state
  transitions.

Evidence:

- Telegram supports command registration through `setMyCommands`.
- `callback_data` is capped at 64 bytes.

Implementation consequence:

- Prefer opaque server-side IDs such as subscription UUIDs or short signed claim
  tokens, not serialized business objects.

Confidence: high.

### Per-chat rate limiting

Claim:

- Rate limit by `chat.id`, optionally combined with `from.id`, and keep the
  limiter in Redis.

Evidence:

- `@grammyjs/ratelimiter` supports a custom `keyGenerator`, penalties, and a
  Redis backend.
- `@grammyjs/runner` documents per-chat sequentialization to avoid session
  hazards.

Implementation consequence:

- Use low limits for command spam and callback bursts, for example:
  `chat.id` 5-10 actions per 10 seconds, separate lower limit for expensive
  summary refreshes.

Confidence: high.

### Graceful shutdown and update idempotency

Claim:

- The bot must have a single active poller, persisted cursor, and awaited stop.

Evidence:

- Telegram confirms updates through `offset`.
- grammY runner supports awaited stop and automatic offset advancement.
- node-telegram-bot-api also advances offset per processed update, confirming
  the core model is standard.

Implementation consequence:

- Persist the last confirmed `update_id` in SQLite or the OmniRoute key-value
  store.
- Keep a singleton lease so two OmniRoute processes do not poll the same bot.
- Make subscription mutations idempotent with unique constraints.

Confidence: high.

### Persistent subscriptions and scheduled alerts

Claim:

- Persistent Telegram subscriptions should be a dedicated OmniRoute table, and
  scheduled notifications should consume existing OmniRoute usage/alert state.

Evidence:

- The comparable stars bot persists subscriptions in a join table and separates
  polling from notification fan-out.
- OmniRoute already has durable quota windows, usage ledgers, and threshold
  alert generation.

Implementation consequence:

- Do not scrape provider quota state inside the bot.
- Reuse `quota.exceeded`, `buildApiKeyUsageAlerts`, and `/api/v1/usage`.

Confidence: high.

### Safe handling of customer API keys

Claim:

- The Telegram bot must never become a place where customers paste or retrieve
  raw API keys.

Evidence:

- OmniRoute already exposes masked-key usage summaries.
- Telegram callback payloads are tiny and chat transcripts are a poor secret
  boundary.

Implementation consequence:

- Bind chats to existing OmniRoute API keys through a one-time claim token or an
  admin-only management action.
- Store only `api_key_id`, masked prefix, subscription preferences, and chat
  metadata.
- When responding in chat, show masked prefixes and summarized usage only.

Confidence: high.

## Recommended Architecture For OmniRoute

Use `grammY` plus `@grammyjs/runner` and `@grammyjs/ratelimiter`, with long
polling as the initial transport.

Recommended shape:

1. Intake
   - One bot process or one elected poller per deployment.
   - On startup, call `deleteWebhook` once, then long-poll with persisted
     `update_id` cursor.
   - On shutdown, await runner stop and release the singleton lease.

2. Chat model
   - Private-chat only for the first release.
   - Commands: `/start`, `/status`, `/watch`, `/unwatch`, `/alerts`, `/mute`,
     `/help`.
   - Inline keyboards for acknowledgement and watch/unwatch actions using opaque
     short IDs only.

3. Persistence
   - Add durable tables such as `telegram_chats`, `telegram_subscriptions`,
     `telegram_delivery_log`, and `telegram_bot_state`.
   - Put unique constraints on `(chat_id, api_key_id, alert_kind)` or equivalent
     subscription keys.
   - Persist the last processed `update_id` and any notification dedupe cursor.

4. Data access
   - Read usage through internal OmniRoute functions or the existing
     `/api/v1/usage` response shape.
   - Trigger proactive alerts from `quota.exceeded` and periodic summary jobs.
   - Never duplicate token accounting inside the bot.

5. Security
   - Never store raw customer API keys in Telegram-facing state.
   - Use a short-lived claim token created from the dashboard or management API
     to link a Telegram chat to an existing `api_key_id`.
   - Apply per-chat Redis rate limits and per-chat sequentialization.
   - Log bot actions without sensitive content and reuse OmniRoute's masked-key
     display behavior.

6. Scheduled alerts
   - Reuse the existing alert thresholds for 90/95/100 percent.
   - Add a scheduled summary worker only for reminder-style notifications, not
     for primary quota enforcement.
   - Dedupe notifications by threshold window and chat subscription.

## Recommendation Strength

Recommendation: proceed with a grammY-based long-polling bot that reuses
OmniRoute's existing usage/quota/alert primitives and stores only chat
subscriptions plus internal key references.

Rationale:

- This is the strongest match to the Telegram delivery model, OmniRoute's
  current architecture, and the requirement to avoid handling customer secrets
  in chat.
- The primary-source evidence is sufficient to recommend this now.

## High-Impact Unknowns

- Whether the bot is intended for internal operators only, or also for external
  customer self-service chats. That choice changes authorization and onboarding.
- Whether OmniRoute will run one process or multiple replicas for the bot. That
  choice changes how strict the singleton poller lease must be.
- Whether the team wants the bot to call internal functions directly or go
  through HTTP management endpoints for clearer isolation.

## Next Evidence-Gathering Step

Design the exact claim-token onboarding flow and database schema for
`telegram_subscriptions`, then verify it against OmniRoute's current authz and
masked-key exposure rules before implementation.
