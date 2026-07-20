# QRouter Telegram Token Alert Bot Design

Date: 2026-07-19
Status: Implemented; compact dashboard, `/check`, paginated logs, and callback throttling approved 2026-07-20

## Context

QRouter customers need a Telegram bot at `@qrouter_token_bot` that shows the same key
usage information as the customer usage page and proactively warns before quotas or keys
expire. Existing OmniRoute code already computes customer usage, quota state, and 90/95/100
percent alerts. The bot must reuse those rules instead of maintaining a second accounting
system.

Primary-source and repository research is captured in
`docs/research/telegram-token-bot-patterns-2026-07-19.md`.

## Goals

- Provide a compact, visually scannable private-chat dashboard for key status and primary usage.
- Let a linked customer refresh the dashboard with `/check` without submitting the key again.
- Show recent request logs only on demand, ten rows per page, with in-message pagination.
- Notify linked customers at 90, 95, and 100 percent daily or lifetime token usage.
- Notify customers when a key is within seven days, one day, or zero days of expiry.
- Accept an API key directly in the private bot chat, validate it through OmniRoute, and never echo, log, or persist the raw key.
- Best-effort delete the inbound Telegram message containing the API key immediately after receipt.
- Survive restarts without duplicate subscriptions or repeated alert floods.
- Resist command spam, invalid credential guessing, and duplicate bot instances.
- Run locally through long polling for immediate testing, without public HTTPS ingress.

## Non-Goals

- Editing API-key quotas or permissions from Telegram.
- Supporting group chats in the first release.
- Replacing quota enforcement in `apiKeyQuotaLedger.ts`.
- Adding payment, billing, or administrative commands.
- Supporting Telegram webhooks in the first release.

## Chosen Architecture

Use `grammy`, `@grammyjs/runner`, and `@grammyjs/ratelimiter` in a dedicated Node.js
process started by `npm run telegram:token-bot`.

Long polling is the first transport. It avoids a public webhook endpoint, matches the local
test requirement, and has explicit Telegram offset semantics. The runner serializes updates
per chat while allowing independent chats to proceed concurrently. A database lease permits
only one active poller for the bot token.

The bot is a thin presentation and delivery layer:

1. Existing API-key and usage modules remain the source of truth.
2. A shared customer-usage service builds the response currently assembled in the usage API.
3. The customer usage API and Telegram formatter consume that same service.
4. A periodic monitor reads active subscriptions and the same alert builder every 60 seconds.
5. Persistent delivery keys prevent duplicate alerts across restarts.

## Direct Private-Chat Linking

The primary flow accepts the customer's QRouter API key directly in a private conversation
with `@qrouter_token_bot`. The bot immediately attempts to delete the inbound message, validates
the key through the existing API-key lifecycle path, resolves only its internal `api_key_id`, and
stores `chat_id -> api_key_id`. The raw API key is never copied to replies, logs, alert state, or
subscription tables.

Telegram remains the transport for the inbound secret, so the bot copy must clearly require a
private chat and say that deletion is best-effort. Group and channel traffic remains silent.
Invalid, expired, revoked, banned, inactive, or unknown keys receive the same generic response.
Attempts are limited to five per fifteen minutes per chat.

The existing one-time hashed claim/deep-link flow remains supported as a backward-compatible,
optional alternative for links already issued by the Usage page. It is no longer the primary bot
onboarding instruction.

A key may have one active Telegram subscription in the first release. Re-linking the same key
from the same chat is idempotent. A different chat or key cannot silently replace an active
subscription.

## Compact Customer Experience

The production bot uses one linked key per private chat and two views that edit the same Telegram
message instead of adding chat clutter.

### Dashboard view

1. `/start` tells an unlinked customer to send a QRouter API key in the private chat. For an already
   linked customer, `/start` may show the same compact dashboard as `/check`.
2. A submitted key is best-effort deleted, validated against production, and linked by internal
   API-key ID. Successful linking automatically enables alerts.
3. `/check` loads the currently linked key by `chat_id -> api_key_id`; it never asks for or exposes
   the raw key again.
4. The dashboard shows only primary information in short visual groups:
   - key name, masked prefix, state, and expiry;
   - today's request and token usage plus reset time;
   - last-hour request and token usage;
   - lifetime request and token totals;
   - current alert summary and checked time.
5. Unlimited values are summarized once and repeated quota internals, reserved-token accounting,
   input/output lifetime splits, and the full model list are removed from the main view.

The dashboard keyboard contains `🔄 Làm mới`, `📜 Xem log`, and one state-aware alert toggle
(`🔕 Tắt cảnh báo` or `🔔 Bật cảnh báo`). Refresh edits the current message. `/check` sends a compact
result when invoked as a command, while callback refreshes edit the existing dashboard.

### Request-log view

`📜 Xem log` queries sanitized customer request-log summaries using only the subscription's internal
API-key ID. It shows ten newest rows per page. Each row contains outcome, local timestamp, model,
HTTP status, latency, total tokens, and a short sanitized error only when present. It never includes
prompt or response bodies, raw keys, provider credentials, or detailed pipeline payloads.

The log keyboard contains bounded `⬅️ Trước` and `Sau ➡️` navigation, a non-action page indicator,
`🏠 Tổng quan`, and `🔄 Làm mới`. Navigation and return actions edit the same message. Empty pages
fall back to the nearest valid page, and an empty log set displays a short no-requests state.
Callback data uses short allowlisted actions and page numbers only; key IDs never appear in callback
data.

The public Telegram command menu contains `/start` and `/check`. Existing hashed claim links remain
accepted silently for backward compatibility. Group or channel messages receive no usage or log
data. API-key names, model names, error summaries, and other database text are escaped before
Telegram HTML rendering.

## Alert Semantics

Daily and lifetime alerts reuse `buildApiKeyUsageAlerts` and the existing thresholds:

- 90 percent: warning;
- 95 percent: critical;
- 100 percent: exhausted.

If usage jumps across multiple thresholds between checks, the bot sends one message that lists
all newly crossed thresholds and records each as delivered. Daily threshold delivery keys
include the daily reset timestamp so the next usage window is re-armed. Lifetime delivery keys
never reset unless the configured lifetime limit changes.

Expiry notifications are delivered once at these states:

- seven days or less;
- one day or less;
- expired.

The delivery key contains subscription ID, metric, threshold or expiry state, quota-window
identity, and relevant configured limit. This allows a changed limit or expiry date to re-arm
the correct alert without flooding unchanged subscriptions.

## Persistence

Add one idempotent migration and one DB domain module for these tables:

- `telegram_link_claims`: token hash, API-key ID, expiry, consumed timestamp, created timestamp.
- `telegram_subscriptions`: ID, chat ID, API-key ID, enabled state, mute timestamp, created and
  updated timestamps. Unique active ownership is enforced for API-key ID.
- `telegram_alert_deliveries`: subscription ID, dedupe key, delivery status, attempt count,
  Telegram message ID, last error code, timestamps. The dedupe key is unique.
- `telegram_bot_state`: singleton lease owner and expiry plus operational cursor metadata.

All queries are parameterized and live in the DB module, not routes or the bot runtime.
Foreign-key deletion cascades remove claims, subscriptions, and delivery state when appropriate.
Expired claims and old successful delivery rows receive bounded cleanup.

## Security And Abuse Controls

Trust boundaries are Telegram updates containing raw API keys or legacy claim tokens, API-key
database text, and Telegram API responses. Assets are customer usage data, raw key material,
chat-to-key ownership, the bot token, and service availability.

Controls:

- Bot token is required through `QROUTER_TELEGRAM_BOT_TOKEN`; it is never logged or committed.
- Local testing uses ignored `.env.telegram.local`; production uses the deployment secret store.
- Private chats only; no customer data in groups or channels.
- Submitted API keys are validated through the existing lifecycle checks and converted to an internal ID before persistence.
- The inbound key message is deleted on a best-effort basis and the key is never echoed, logged, or stored in Telegram bot tables.
- Legacy claim tokens retain 256 bits of randomness, hashed storage, ten-minute expiry, and atomic consumption.
- Per-chat sequentialization prevents concurrent state races.
- General commands are limited per private chat; `/check`, dashboard refresh, log refresh, and log
  pagination share a three-second action cooldown and a ten-actions-per-minute ceiling.
- Throttled callbacks only answer the callback with a short wait message; they do not query the
  database, edit the dashboard, or add a chat message.
- Invalid direct keys and legacy claims share a limit of 5 attempts per 15 minutes per chat.
- At most 5 active watched keys per chat is reserved for a later multi-key release; the first
  release permits one key and one chat.
- Incoming text is capped before parsing; only an allowlisted command/callback grammar runs.
- Callback data contains opaque short action IDs, never key IDs or credentials.
- Outbound calls have timeouts, bounded retries, and Telegram `retry_after` handling.
- Logs contain chat ID hash, update ID, action, outcome, and error code only. They exclude
  usernames, message text, claim tokens, API keys, and Telegram bot URLs.
- A renewable SQLite lease rejects a second active bot process.
- Startup checks `getWebhookInfo`; it does not silently delete a configured production webhook
  unless `QROUTER_TELEGRAM_ALLOW_DELETE_WEBHOOK=true` is explicitly set.

## Error Handling And Operations

- Invalid, unknown, expired, revoked, banned, or inactive API keys and invalid legacy claims return the same generic message to avoid credential-state disclosure.
- Revoked, banned, inactive, deleted, or expired keys disable monitoring and send one terminal
  status message when safe.
- Telegram 403 responses mark a subscription disabled because the user blocked the bot.
- Telegram 429 responses honor `retry_after` and do not increment permanent failure counters.
- Other transient Telegram failures use bounded exponential backoff.
- The monitor has an overlap guard, so a slow pass cannot run concurrently with the next pass.
- `SIGINT` and `SIGTERM` stop polling, stop the monitor, release the lease, and await in-flight
  work.
- A `/health` HTTP server is not required for the first local process. Structured startup and
  heartbeat logs provide the initial operational signal.

## Test Seams

Tests exercise public behavior at these seams:

1. Direct token flow: lifecycle validation, raw-key non-persistence, internal-ID linking, idempotency, and best-effort Telegram message deletion.
2. Legacy claim service: issue, consume, expiry, replay rejection, and concurrent first-wins behavior.
3. Subscription DB module: uniqueness, disconnect, mute, lease ownership, and cleanup.
4. Bot update handler: compact dashboard formatting, `/check`, private-chat enforcement, escaped
   output, command/callback throttling, generic invalid-credential handling, and idempotent
   subscription mutations.
5. Request-log view: API-key ownership filtering, ten rows per page, previous/next boundaries,
   refresh, return to dashboard, empty logs, sanitized errors, and message-length bounds.
6. Alert monitor: 90/95/100 transitions, multi-threshold jumps, reset re-arming, expiry stages,
   mute behavior, 403 disablement, 429 retry, and persistent dedupe after restart.
7. Customer link API and usage UI: backward-compatible authenticated claim creation and safe deep-link rendering.
8. Live smoke: Telegram `getMe`, direct private-chat linking, `/check`, one log-page navigation,
   alert toggling, and one controlled test notification.

No test or log fixture may contain the real Telegram bot token or a real customer API key.

## Acceptance Criteria

- A customer can submit an API key directly to the private bot, which validates it, attempts to delete the inbound message, and persists only the internal API-key ID.
- A valid submitted key automatically enables alerts and immediately returns the compact masked dashboard.
- `/check` displays the linked key's current primary usage without requiring the raw key again.
- The dashboard is visually grouped and omits repeated unlimited quota rows and the full model list.
- The dashboard exposes refresh, request logs, and one state-aware alert toggle.
- Request logs are hidden until requested, show ten sanitized summaries per page, and paginate by editing the same message.
- The public command menu contains `/start` and `/check`; obsolete commands remain absent.
- Automatic notifications arrive once at 90, 95, and 100 percent and re-arm after daily reset when alerts are enabled.
- Expiry notifications arrive once at seven days, one day, and expiry.
- Restarting the bot does not duplicate subscriptions or previously delivered alerts.
- Spam attempts are throttled without exposing API-key or legacy-claim validity.
- Two bot processes cannot poll concurrently.
- Targeted tests pass on a repository-supported Node.js version.
- The local bot is running and verified against `@qrouter_token_bot` before handoff.

## Production Deployment

The bot runs as a dedicated long-polling Docker sidecar on `84.247.144.97`. It shares the named
production data volume and production environment with `omniroute-prod`, so API-key validation,
usage aggregation, quota state, and alert delivery use production data directly. The Telegram token
is supplied through a separate root-readable env file and is never baked into an image or copied to
logs.

The sidecar image contains a bundled bot entry point and the complete migration directory. It uses
Node's built-in SQLite driver on Node 26, starts only after the main application is healthy, uses
`restart: unless-stopped`, and does not expose a network port. The local long-polling bot must be
stopped before production polling starts because Telegram permits one active `getUpdates` consumer
per bot token. Deployment backs up the production SQLite database before applying migrations and
must not recreate or replace the healthy application container.

## Delivery Boundary

The release uses long polling and SQLite-backed subscriptions. Production webhook transport, multi-key-per-chat support, prompt/response log details, dashboard
administration, email/Discord delivery, and horizontal multi-node bot workers remain out of scope.
