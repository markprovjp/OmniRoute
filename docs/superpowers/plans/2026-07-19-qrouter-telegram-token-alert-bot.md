# QRouter Telegram Token Alert Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run `@qrouter_token_bot` so customers can securely link an OmniRoute API key, inspect masked usage, and receive deduplicated 90/95/100 percent and expiry alerts.

**Architecture:** A grammY long-polling process consumes Telegram updates while OmniRoute remains the source of truth for key status, usage, and alert thresholds. The primary onboarding path validates a directly submitted API key in a private chat, best-effort deletes its Telegram message, and persists only the resolved API-key ID. One-time hashed claims remain as a backward-compatible alternative. SQLite persists subscriptions, poller lease state, and alert delivery dedupe without storing raw customer keys.

**Tech Stack:** Node.js 24, TypeScript 5.9, grammY, `@grammyjs/runner`, `@grammyjs/ratelimiter`, Next.js App Router, better-sqlite3, Zod, Node test runner.

## Global Constraints

- Run on Node.js `>=22.22.3 <23 || >=24.0.0 <27`; live verification uses `D:\tools\node-v24.15.0-win-x64\node.exe`.
- Keep the bot token only in ignored `.env.telegram.local` for local testing and `QROUTER_TELEGRAM_BOT_TOKEN` in production.
- Never persist, log, or render a raw customer API key or claim token. Directly submitted key messages must be deleted on a best-effort basis and never echoed.
- Accept customer commands and API-key submissions only in private Telegram chats.
- Reuse `buildApiKeyUsageAlerts`; do not duplicate quota accounting or enforcement.
- General commands: 6 per minute per chat; invalid claims: 5 per 15 minutes per chat.
- Monitor active subscriptions every 60 seconds with a non-overlap guard.
- Preserve all unrelated dirty-worktree changes and stage only task-owned files.

---

## 2026-07-20 Direct-token amendment

The approved product behavior now makes direct private-chat API-key submission the primary onboarding path. Implementation must use the existing API-key lifecycle validator, resolve only the internal key ID, persist no raw key, delete the inbound Telegram message on a best-effort basis, return one generic invalid-credential response, and retain hashed claims only for backward compatibility. The focused bot, DB, and runtime tests cover this amendment.

---

### Task 1: Shared Customer Usage Snapshot

**Files:**
- Create: `src/lib/usage/apiKeyCustomerUsage.ts`
- Modify: `src/app/api/v1/usage/route.ts`
- Modify: `tests/unit/api-key-usage-route.test.ts`
- Test: `tests/unit/api-key-customer-usage.test.ts`

**Interfaces:**
- Consumes: `getApiKeyById(id)`, `getApiKeyUsageSummaries`, `getApiKeyQuotaSnapshot`, `getApiKeyModelUsage`, `buildApiKeyUsageAlerts`.
- Produces: `buildApiKeyCustomerUsage(apiKey, options?) => ApiKeyCustomerUsage` and `getApiKeyCustomerUsageById(apiKeyId) => Promise<ApiKeyCustomerUsage | null>`.

- [ ] **Step 1: Write failing service tests**

Cover an active key at 95 percent, a key with no limits, and a deleted key lookup. Assert the literal public contract:

```typescript
const snapshot = await usage.buildApiKeyCustomerUsage(apiKey, {
  rawKeyForMasking: apiKey.key,
  now: new Date("2026-07-19T00:00:00.000Z"),
});
assert.equal(snapshot.key.state, "active");
assert.equal(snapshot.key.prefix.includes("****"), true);
assert.equal(snapshot.alerts[0]?.thresholdPercent, 95);
assert.equal("key" in snapshot, true);
assert.equal(JSON.stringify(snapshot).includes(apiKey.key), false);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests/unit/api-key-customer-usage.test.ts`

Expected: FAIL because `apiKeyCustomerUsage.ts` does not exist.

- [ ] **Step 3: Extract the route computation into the service**

Define stable types and accept masking separately so ID-based bot lookups never need raw keys:

```typescript
export interface ApiKeyCustomerUsageOptions {
  rawKeyForMasking?: string | null;
  now?: Date;
}

export async function getApiKeyCustomerUsageById(
  apiKeyId: string,
  options: ApiKeyCustomerUsageOptions = {}
): Promise<ApiKeyCustomerUsage | null> {
  const apiKey = await getApiKeyById(apiKeyId);
  return apiKey ? buildApiKeyCustomerUsage(apiKey, options) : null;
}
```

When no raw key is available, use the stored `keyPrefix` through `maskStoredApiKey`; never load or return the legacy plaintext key column for Telegram.

- [ ] **Step 4: Make the usage route delegate to the service**

Keep `readUsageKey`, authentication errors, CORS, and HTTP status handling in the route. Replace response assembly with:

```typescript
const usage = await buildApiKeyCustomerUsage(apiKey, { rawKeyForMasking: rawKey });
return NextResponse.json(usage, { headers: CORS_HEADERS });
```

- [ ] **Step 5: Run focused tests and commit**

Run both Task 1 test files. Expected: PASS.

Commit: `refactor(usage): share customer key usage snapshot`

---

### Task 2: Durable Telegram Claims And Subscriptions

**Files:**
- Create: `src/lib/db/migrations/067_telegram_token_bot.sql`
- Create: `src/lib/db/telegramBot.ts`
- Modify: `src/lib/localDb.ts`
- Test: `tests/unit/telegram-bot-db.test.ts`

**Interfaces:**
- Produces: `createTelegramLinkClaim`, `consumeTelegramLinkClaim`, `getTelegramSubscriptionByChat`, `listActiveTelegramSubscriptions`, `disconnectTelegramSubscription`, `setTelegramMute`, `reserveTelegramAlertDelivery`, `recordTelegramAlertDelivery`, `acquireTelegramBotLease`, `renewTelegramBotLease`, `releaseTelegramBotLease`.

- [ ] **Step 1: Write failing DB tests**

Test hashed-token storage, ten-minute expiry, replay rejection, concurrent first-wins claim consumption, unique key ownership, mute/disconnect, unique alert dedupe, and singleton lease takeover after expiry.

```typescript
const claim = telegramDb.createTelegramLinkClaim("key-1", now);
assert.equal(claim.token.length >= 43, true);
assert.equal(JSON.stringify(telegramDb.__testListClaims()).includes(claim.token), false);
const first = telegramDb.consumeTelegramLinkClaim(claim.token, "12345", now);
const replay = telegramDb.consumeTelegramLinkClaim(claim.token, "99999", now);
assert.equal(first?.apiKeyId, "key-1");
assert.equal(replay, null);
```

- [ ] **Step 2: Run the DB test and verify RED**

Run: `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests/unit/telegram-bot-db.test.ts`

Expected: FAIL because the migration and module do not exist.

- [ ] **Step 3: Add the idempotent migration**

Create the four tables from the design: `telegram_link_claims`, `telegram_subscriptions`, `telegram_alert_deliveries`, and `telegram_bot_state`. Use foreign keys to `api_keys(id)`, parameterized access in the module, `UNIQUE(api_key_id)` for first-release ownership, and `UNIQUE(subscription_id, dedupe_key)` for alert dedupe.

- [ ] **Step 4: Implement atomic claim and lease operations**

Hash claims before storage:

```typescript
function hashClaim(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

Consume a claim and create the subscription in one SQLite transaction. Acquire a lease with a conditional upsert that succeeds only when the previous lease expired or already belongs to the same owner.

- [ ] **Step 5: Run focused tests and commit**

Expected: all DB tests PASS and `git diff --check` reports no errors.

Commit: `feat(telegram): persist secure bot subscriptions`

---

### Task 3: Customer Claim API

**Files:**
- Create: `src/lib/telegramTokenBot/linkClaims.ts`
- Create: `src/app/api/customer/telegram-link/route.ts`
- Test: `tests/unit/telegram-link-route.test.ts`

**Interfaces:**
- Consumes: `getApiKeyMetadata(rawKey)` and `createTelegramLinkClaim(apiKeyId, now)`.
- Produces: `POST /api/customer/telegram-link` response `{ success, deepLink, expiresAt }`.

- [ ] **Step 1: Write failing route tests**

Cover missing key `401`, invalid key `401`, inactive/revoked/banned/expired key `403`, valid key `200`, and absence of raw key/token in logs and persistence.

```typescript
assert.match(body.deepLink, /^https:\/\/t\.me\/qrouter_token_bot\?start=[A-Za-z0-9_-]{43}$/);
assert.equal(body.expiresAt, "2026-07-19T00:10:00.000Z");
assert.equal(JSON.stringify(body).includes(apiKey.key), false);
```

- [ ] **Step 2: Run the route test and verify RED**

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement validated claim issuance**

Read `apiKey` or `key` from JSON exactly like the usage endpoint, cap input length, validate lifecycle gates, and build the username from `QROUTER_TELEGRAM_BOT_USERNAME` with default `qrouter_token_bot`. Return generic auth errors and set `Cache-Control: no-store`.

- [ ] **Step 4: Run focused tests and commit**

Run: `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests/unit/telegram-link-route.test.ts`

Expected: PASS.

Commit: `feat(api): issue Telegram alert claim links`

---

### Task 4: Customer Usage Page Link Action

**Files:**
- Modify: `src/app/usage/CustomerUsagePageClient.tsx`
- Test: `tests/unit/customer-usage-telegram-link.test.ts`

**Interfaces:**
- Consumes: `POST /api/customer/telegram-link`.
- Produces: a visible `Connect Telegram alerts` button after successful key lookup and opens the returned `https://t.me/...` link.

- [ ] **Step 1: Write a failing source-contract test**

Assert the component calls only the fixed same-origin endpoint, sends the already-entered API key in a POST body, handles non-OK responses, disables duplicate clicks, and never renders the raw key into an `href`.

- [ ] **Step 2: Run the test and verify RED**

Expected: FAIL because the Telegram action is absent.

- [ ] **Step 3: Add the small link card**

Preserve the existing page visual language. Add one compact card below the alerts with a Telegram icon, one sentence explaining 90/95/100 and expiry alerts, and a single button. Use loading, success, and generic failure states; open only a response URL that starts with `https://t.me/qrouter_token_bot?start=`.

- [ ] **Step 4: Run React Doctor and focused tests**

Run global React Doctor project detection and scan, then run the Task 4 test. Expected: no new React findings and PASS.

- [ ] **Step 5: Commit**

Commit: `feat(usage): add secure Telegram alert linking`

---

### Task 5: Telegram Commands And Long-Polling Runtime

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Create: `src/lib/telegramTokenBot/messages.ts`
- Create: `src/lib/telegramTokenBot/bot.ts`
- Create: `src/lib/telegramTokenBot/runtime.ts`
- Create: `scripts/telegram/token-bot.ts`
- Test: `tests/unit/telegram-token-bot.test.ts`

**Interfaces:**
- Consumes: subscription DB functions and `getApiKeyCustomerUsageById`.
- Produces: `createTelegramTokenBot(deps)`, `startTelegramTokenBot(options)`, commands `/start`, `/status`, `/usage`, `/alerts`, `/mute`, `/unmute`, `/disconnect`, `/help`.

- [ ] **Step 1: Install reviewed dependencies**

Run with Node 24 npm: `npm install grammy @grammyjs/runner @grammyjs/ratelimiter`.

Add `telegram:token-bot` using Node's ignored env file support and `tsx/esm`.

- [ ] **Step 2: Write failing handler tests with a fake Telegram API**

Cover private-chat claim success, group silence, generic invalid claims, escaped key names, masked usage output, mute/disconnect confirmation, unknown command help, and 6-per-minute throttling.

- [ ] **Step 3: Run the handler test and verify RED**

Expected: FAIL because bot modules do not exist.

- [ ] **Step 4: Implement messages and command handlers**

Use a single HTML escaping helper:

```typescript
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
```

Inline callback data must be a fixed allowlist such as `usage`, `alerts`, `mute24`, `unmute`, `disconnect_confirm`, and `disconnect_cancel`.

- [ ] **Step 5: Implement guarded runtime startup and shutdown**

Require the token env, call `getMe`, verify the username, inspect webhook state, acquire the DB lease, start grammY runner, and register awaited `SIGINT`/`SIGTERM` shutdown. Delete a webhook only when `QROUTER_TELEGRAM_ALLOW_DELETE_WEBHOOK=true`.

- [ ] **Step 6: Run focused tests and commit**

Expected: all bot handler tests PASS; no token appears in `git diff`.

Commit: `feat(telegram): add secure customer usage bot`

---

### Task 6: Automatic Alert Monitor

**Files:**
- Create: `src/lib/telegramTokenBot/alertMonitor.ts`
- Modify: `src/lib/telegramTokenBot/runtime.ts`
- Test: `tests/unit/telegram-alert-monitor.test.ts`
- Modify: `tests/unit/api-key-alerts.test.ts`

**Interfaces:**
- Consumes: active subscriptions, shared usage snapshots, `buildApiKeyUsageAlerts`, delivery reservation/recording, Telegram `sendMessage`.
- Produces: `runTelegramAlertSweep(deps, now) => Promise<TelegramAlertSweepResult>` and `startTelegramAlertMonitor(deps, intervalMs)`.

- [ ] **Step 1: Write failing monitor tests**

Cover exact 90/95/100 transitions, jump from 89 to 96 as one combined message, daily reset re-arm, lifetime limit change re-arm, 7-day/1-day/expired stages, 24-hour mute, persistent restart dedupe, 403 disable, 429 retry-after, transient retry, and overlapping sweep prevention.

- [ ] **Step 2: Run monitor tests and verify RED**

Expected: FAIL because the monitor does not exist.

- [ ] **Step 3: Implement deterministic delivery keys**

```typescript
export function telegramAlertDedupeKey(input: {
  metric: "daily_tokens" | "lifetime_tokens" | "key_expiry";
  threshold: number | string;
  resetAt?: string | null;
  configuredLimit?: number | string | null;
}): string {
  return [input.metric, input.threshold, input.resetAt ?? "never", input.configuredLimit ?? "none"].join(":");
}
```

Reserve the unique delivery row before sending. Record success, Telegram message ID, 429 retry schedule, or terminal failure without releasing a successfully delivered dedupe key.

- [ ] **Step 4: Add the 60-second non-overlapping scheduler**

Run one immediate sweep after startup, then every 60 seconds. Skip if the previous sweep is active. Stop and await the active sweep during shutdown.

- [ ] **Step 5: Run focused tests and commit**

Expected: monitor and alert helper tests PASS.

Commit: `feat(telegram): deliver deduplicated quota alerts`

---

### Task 7: Security Review And Live Bot Verification

**Files:**
- Create ignored local file: `.env.telegram.local`
- Modify only if review finds issues: Task 1-6 owned files

**Interfaces:**
- Verifies the complete customer flow and local runtime.

- [ ] **Step 1: Format and run targeted verification**

Run Prettier on all changed code. Run each new unit file individually with Node 24, then `tests/unit/api-key-alerts.test.ts` and `tests/unit/api-key-usage-route.test.ts`.

- [ ] **Step 2: Run type and dependency security checks**

Run `npm run typecheck:core` and classify only new errors as blockers. Run `npm audit --audit-level=high`; no new reachable high/critical issue from the three bot dependencies may remain.

- [ ] **Step 3: Perform an independent code review**

Review for raw-key leakage, token leakage, claim replay, chat takeover, SQL concatenation, HTML injection, missing private-chat enforcement, unbounded retries, duplicate pollers, alert floods, and shutdown races. Fix all Critical/High findings and rerun focused tests.

- [ ] **Step 4: Configure the local secret without Git exposure**

Create ignored `.env.telegram.local` with `QROUTER_TELEGRAM_BOT_TOKEN`, `QROUTER_TELEGRAM_BOT_USERNAME=qrouter_token_bot`, and safe local polling settings. Verify `git check-ignore -v .env.telegram.local` and scan staged diffs for the real token.

- [ ] **Step 5: Start on the supported Node 24 runtime**

Start the bot as a hidden background process. If the customer usage UI is needed for the claim flow, first start OmniRoute on `http://localhost:20129` without killing any unrelated listener.

- [ ] **Step 6: Verify Telegram and customer flow**

Verify `getMe` resolves `@qrouter_token_bot`, `getWebhookInfo` is compatible with polling, the process holds the singleton lease, and Telegram accepts `setMyCommands`. Complete one real private-chat `/start`, claim link, `/usage`, and controlled alert message.

- [ ] **Step 7: Final scoped commit**

Stage only Task 1-7 source, migration, package, env-template, and tests. Exclude `.env.telegram.local`, logs, databases, `artifacts/`, and unrelated dirty files. Run `git diff --cached --check` and commit:

`feat(telegram): ship customer quota alert bot`

## 2026-07-20 Minimal production UX amendment

The user approved Option A: show the complete usage/quota/model snapshot but omit recent request
logs. The bot must expose one `/start` command and exactly one state-aware alert toggle button.
Production runs as an isolated sidecar against the existing production data volume; deployment must
not rebuild or recreate `omniroute-prod`.

### Task 8: Minimal one-button bot UX

**Files:**
- Modify: `src/lib/telegramTokenBot/bot.ts`
- Modify: `src/lib/telegramTokenBot/messages.ts`
- Modify: `src/lib/telegramTokenBot/alertMonitor.ts`
- Modify: `src/lib/telegramTokenBot/runtime.ts`
- Test: `tests/unit/telegram-token-bot.test.ts`
- Test: `tests/unit/telegram-alert-monitor.test.ts`
- Test: `tests/unit/telegram-token-bot-runtime.test.ts`

**Interfaces:**
- `getUsage(apiKeyId)` returns the existing `ApiKeyCustomerUsage` contract.
- `setMute(chatId, null)` enables alerts.
- `setMute(chatId, new Date("9999-12-31T23:59:59.999Z"))` disables all alerts.
- Callback allowlist becomes exactly `toggle_alerts`.

- [ ] Write handler tests asserting a submitted key automatically enables alerts, returns the full
      Option A snapshot, escapes all database strings, stays below 4,096 characters, and renders
      only `🔕 Tắt cảnh báo`.
- [ ] Write callback tests asserting the same button toggles to `🔔 Bật cảnh báo`, changes no
      subscription ownership, and edits the keyboard without sending a new message.
- [ ] Write monitor tests asserting disabled alerts suppress warning, exhausted, and expiry
      deliveries until re-enabled.
- [ ] Run the three focused tests and observe failures caused by the existing multi-command UI,
      short formatter, and terminal-alert mute bypass.
- [ ] Replace the narrow Telegram usage type with `ApiKeyCustomerUsage`, add a bounded HTML
      formatter for all approved sections and top token-consuming models, remove legacy command
      handlers/buttons, and make successful key submission call `setMute(chatId, null)` before
      formatting usage.
- [ ] Change the alert monitor to skip every candidate while the subscription is muted and remove
      obsolete `/usage` and `/mute` instructions from automatic alert copy.
- [ ] Set the Telegram command menu to only `{ command: "start", description: "Kiểm tra API key QRouter" }`.
- [ ] Re-run focused tests until green.

### Task 9: Reproducible production sidecar

**Files:**
- Create: `scripts/build/build-telegram-bot.mjs`
- Create: `Dockerfile.telegram`
- Modify: `docker-compose.prod.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/unit/telegram-production-packaging.test.ts`

**Interfaces:**
- Build output: `.dist/telegram/telegram-token-bot.mjs`.
- Production image: `omniroute-telegram-bot:prod`.
- Production service: `omniroute-telegram-bot`.
- Secret env file: `.env.telegram` with mode `0600`; never committed or printed.
- Shared volume: `omniroute-prod-data:/app/data`.

- [ ] Write a source-contract test asserting the sidecar has no ports, waits for
      `omniroute-prod: service_healthy`, uses `restart: unless-stopped`, disables the inherited web
      healthcheck, mounts the production data volume, and reads `.env` plus `.env.telegram`.
- [ ] Write a build-contract test asserting the Dockerfile copies only the bundled entry point and
      migrations into the Node 26 runtime image and never copies `.env*`.
- [ ] Run the packaging test and observe failure because the sidecar files/service do not exist.
- [ ] Add `esbuild` as a direct dev dependency and implement the deterministic Node ESM bundle with
      `platform: "node"`, `target: "node26"`, and no embedded credentials.
- [ ] Add `npm run build:telegram` and build the sidecar image locally from `Dockerfile.telegram`.
- [ ] Run the focused packaging test and start the image against an isolated temporary SQLite
      volume with fake Telegram API dependencies where possible; verify migration discovery and
      bundle startup errors are actionable.

### Task 10: Production deployment and smoke verification

**Files:**
- Deploy only task-owned files to a timestamped directory under `/opt` on `84.247.144.97`.
- Preserve the active release and `omniroute-prod` container unchanged.

- [ ] Run Prettier, focused ESLint, focused Telegram tests, `git diff --check`, and classify the
      existing unrelated core typecheck failures.
- [ ] Create a SQLite backup through the SQLite backup API or an online-safe backup command before
      starting the new sidecar; verify `PRAGMA integrity_check` returns `ok`.
- [ ] Build `omniroute-telegram-bot:prod` in the timestamped deployment directory and transfer the
      ignored local Telegram env file directly to `.env.telegram` with mode `0600`, without reading
      or printing its values.
- [ ] Stop the exact local `scripts/telegram/token-bot.ts` PID and wait until no local
      `getUpdates` consumer remains.
- [ ] Start only `omniroute-telegram-bot`; do not run a compose command that recreates
      `omniroute-prod`, Redis, PostgreSQL, PgBouncer, or the watchdog.
- [ ] Verify the sidecar remains running across two lease-renewal intervals, logs contain no secret
      patterns, the production DB records the new migration, and Telegram `getMyCommands` exposes
      only `/start`.
- [ ] Smoke-test one private-chat key submission against production data, confirm the response
      contains the Option A sections and one toggle button, then verify toggling suppresses and
      re-enables monitor delivery state without exposing the raw key.

## 2026-07-20 Compact dashboard and paginated-log amendment

The approved UX replaces the exhaustive usage dump with a compact dashboard, adds `/check`, and
moves sanitized request logs behind a ten-row paginated view. All callback navigation edits the
same Telegram message and is protected by per-chat cooldown and rolling-window limits. This
amendment supersedes Task 8's one-button constraint and Task 10's `/start`-only command menu.

### Task 11: Compact dashboard, `/check`, pagination, and action throttling

**Files:**
- Modify: `src/lib/usage/apiKeyRequestLogs.ts`
- Modify: `src/lib/telegramTokenBot/bot.ts`
- Modify: `src/lib/telegramTokenBot/messages.ts`
- Modify: `src/lib/telegramTokenBot/runtime.ts`
- Modify: `tests/unit/api-key-usage-route.test.ts`
- Modify: `tests/unit/telegram-token-bot.test.ts`
- Modify: `tests/unit/telegram-token-bot-runtime.test.ts`

**Interfaces:**
- Produce `getApiKeyRequestLogPage({ apiKeyId, page, pageSize, status })` returning sanitized
  `{ logs, page, pageSize, total, totalPages, summary }`.
- Add `getRequestLogPage(apiKeyId, page)` to `TelegramTokenBotDeps`.
- Allow callback actions `refresh_dashboard`, `show_logs:<page>`, `refresh_logs:<page>`,
  `show_dashboard`, `toggle_alerts`, and `noop` only.

- [ ] Write a failing DB/service test that inserts 23 logs for one key plus one foreign-key log,
      requests pages 1, 2, and 3 at size 10, and asserts lengths `10, 10, 3`, `totalPages === 3`,
      newest-first ordering, page clamping, and no row from the foreign key.
- [ ] Run `api-key-usage-route.test.ts` and verify RED because
      `getApiKeyRequestLogPage` does not exist.
- [ ] Implement a parameterized count query and a summary-row query with bounded `LIMIT` and
      `OFFSET`. Clamp page size to `1..25`, clamp page to `1..totalPages`, and reuse the existing
      sanitized `mapRequestLogRow` output.
- [ ] Add failing bot tests for the compact dashboard, removal of the full model list and repeated
      quota internals, `/check` without raw-key resubmission, ten-row log pages, next/previous
      navigation, dashboard return, callback refresh, HTML escaping, and empty logs.
- [ ] Add failing throttling tests using the injected clock: one accepted action per three seconds,
      at most ten actions per rolling minute, throttled callbacks answer `Vui lòng chờ một chút`,
      and throttled actions perform no usage/log query or message edit.
- [ ] Replace the exhaustive formatter with a compact HTML dashboard containing key state/expiry,
      today, last hour, lifetime, alert summary, reset, and checked time. Use compact `K/M/B`
      number formatting and keep the result substantially below Telegram's 4,096-character limit.
- [ ] Implement the ten-row log formatter with status icon, time, model, HTTP status, latency,
      token total, and sanitized error. Build previous/next, page indicator, dashboard, and refresh
      keyboards with short callback data and no key identifiers.
- [ ] Implement `/check` and callback routing from the current subscription only. Commands send a
      compact dashboard; callbacks use `editMessageText` so refresh and pagination do not add chat
      messages. Keep all private-chat and raw-key protections.
- [ ] Register exactly `/start` and `/check` in `runtime.ts`, inject
      `getApiKeyRequestLogPage`, and rerun bot/runtime/service tests until GREEN.
- [ ] Run the complete focused Telegram suite, Prettier, focused ESLint, build-contract tests,
      secret-pattern scan, and `git diff --check`; record unrelated core typecheck failures.
- [ ] Rebuild only the production Telegram sidecar, retain the pre-migration database backup,
      start only that service, and verify zero restarts, active lease, `/start` plus `/check`, no
      webhook, clean logs, compact dashboard, ten-row pagination, callback throttling, and healthy
      unchanged main-app image.

## Plan Self-Review

- Spec coverage: shared usage, secure claim linking, private-chat UX, persistence, 90/95/100 alerts, expiry alerts, anti-spam, lease, shutdown, compact dashboard, `/check`, ten-row request-log pagination, production sidecar deployment, live verification, and secret handling all have owning tasks.
- Placeholder scan: complete; every implementation step is concrete.
- Type consistency: the usage snapshot, subscription DB, claim route, bot runtime, and monitor interfaces are defined before consumers use them.
