# QRouter Telegram Token Alert Bot Design

Date: 2026-07-19
Status: Approved product direction; implementation pending

## Context

QRouter customers need a Telegram bot at `@qrouter_token_bot` that shows the same key
usage information as the customer usage page and proactively warns before quotas or keys
expire. Existing OmniRoute code already computes customer usage, quota state, and 90/95/100
percent alerts. The bot must reuse those rules instead of maintaining a second accounting
system.

Primary-source and repository research is captured in
`docs/research/telegram-token-bot-patterns-2026-07-19.md`.

## Goals

- Provide a simple private-chat interface for key status and usage.
- Notify linked customers at 90, 95, and 100 percent daily or lifetime token usage.
- Notify customers when a key is within seven days, one day, or zero days of expiry.
- Keep raw customer API keys out of Telegram messages and bot persistence.
- Survive restarts without duplicate subscriptions or repeated alert floods.
- Resist command spam, invalid claim guessing, and duplicate bot instances.
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

## Secure Chat Linking

Customers must not paste API keys into Telegram.

After a successful lookup on `/usage`, the page displays a `Connect Telegram alerts` action.
It submits the already-entered key to a customer-authenticated link endpoint. The endpoint:

- validates the API key through the existing key lookup path;
- creates 32 random bytes and returns only a Telegram deep link;
- stores only the SHA-256 claim-token hash with `api_key_id` and expiry;
- expires the claim after ten minutes;
- permits one successful use and rejects all later attempts.

The deep link opens:

`https://t.me/qrouter_token_bot?start=<opaque_claim_token>`

The bot accepts the claim only in a private chat, consumes it transactionally, and stores
`chat_id -> api_key_id`. No raw customer API key enters Telegram or the subscription tables.
A key may have one active Telegram subscription in the first release. Re-linking requires the
existing chat to disconnect or a fresh management-side reset, preventing silent chat takeover.

## Customer Experience

The bot uses short Vietnamese messages and inline buttons. The home view contains:

- `Xem su dung`: current requests, daily tokens, lifetime tokens, remaining quota, reset time,
  expiry, key state, and top model usage.
- `Canh bao`: active thresholds, last delivery, and mute state.
- `Tam dung 24h`: mute reminder messages for 24 hours; exhausted and expired alerts still send.
- `Ngat lien ket`: require a confirmation button, then disable the subscription.
- `Tro giup`: explain the safe linking flow and provide the customer usage page URL.

Supported commands are `/start`, `/status`, `/usage`, `/alerts`, `/mute`, `/unmute`,
`/disconnect`, and `/help`. Unknown commands receive one compact help response. Group or
channel messages receive no usage data.

Responses show only the existing masked key prefix. API-key names and other database text are
escaped before Telegram HTML rendering.

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

Trust boundaries are Telegram updates, claim tokens, API-key database text, and Telegram API
responses. Assets are customer usage data, chat-to-key ownership, the bot token, and service
availability.

Controls:

- Bot token is required through `QROUTER_TELEGRAM_BOT_TOKEN`; it is never logged or committed.
- Local testing uses ignored `.env.telegram.local`; production uses the deployment secret store.
- Private chats only; no customer data in groups or channels.
- Claim tokens have 256 bits of randomness, are stored hashed, expire in ten minutes, and are
  consumed atomically.
- Per-chat sequentialization prevents concurrent state races.
- General commands are limited to 6 per minute per chat with a short burst limit.
- Claim failures are limited to 5 per 15 minutes per chat and per source claim prefix.
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

- Invalid or expired claims return the same generic message to avoid token-state disclosure.
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

1. Claim service: issue, consume, expiry, replay rejection, and concurrent first-wins behavior.
2. Subscription DB module: uniqueness, disconnect, mute, lease ownership, and cleanup.
3. Bot update handler: private-chat commands, group rejection, escaped output, command rate
   limiting, invalid claim handling, and idempotent subscription mutations.
4. Alert monitor: 90/95/100 transitions, multi-threshold jumps, reset re-arming, expiry stages,
   mute behavior, 403 disablement, 429 retry, and persistent dedupe after restart.
5. Customer link API and usage UI: authenticated claim creation and safe deep-link rendering.
6. Live smoke: Telegram `getMe`, one real private-chat command, one real link, one usage response,
   and one controlled test notification.

No test or log fixture may contain the real Telegram bot token or a real customer API key.

## Acceptance Criteria

- A customer links from `/usage` without sending an API key to Telegram.
- `/usage` returns a readable masked usage summary for the linked key.
- Automatic notifications arrive once at 90, 95, and 100 percent and re-arm after daily reset.
- Expiry notifications arrive once at seven days, one day, and expiry.
- Restarting the bot does not duplicate subscriptions or previously delivered alerts.
- Spam attempts are throttled without exposing key or claim validity.
- Two bot processes cannot poll concurrently.
- Targeted tests pass on a repository-supported Node.js version.
- The local bot is running and verified against `@qrouter_token_bot` before handoff.

## Delivery Boundary

The initial release uses long polling and SQLite-backed subscriptions. Production webhook
transport, multi-key-per-chat support, dashboard administration, email/Discord delivery, and
horizontal multi-node bot workers are deferred until the first bot is operational and observed.
