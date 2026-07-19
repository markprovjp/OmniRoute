# QRouter Telegram Token Alert Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run `@qrouter_token_bot` so customers can securely link an OmniRoute API key, inspect masked usage, and receive deduplicated 90/95/100 percent and expiry alerts.

**Architecture:** A grammY long-polling process consumes Telegram updates while OmniRoute remains the source of truth for key status, usage, and alert thresholds. One-time hashed claim tokens link private Telegram chats to API-key IDs; SQLite persists subscriptions, poller lease state, and alert delivery dedupe without storing raw customer keys.

**Tech Stack:** Node.js 24, TypeScript 5.9, grammY, `@grammyjs/runner`, `@grammyjs/ratelimiter`, Next.js App Router, better-sqlite3, Zod, Node test runner.

## Global Constraints

- Run on Node.js `>=22.22.3 <23 || >=24.0.0 <27`; live verification uses `D:\tools\node-v24.15.0-win-x64\node.exe`.
- Keep the bot token only in ignored `.env.telegram.local` for local testing and `QROUTER_TELEGRAM_BOT_TOKEN` in production.
- Never persist, log, or render a raw customer API key or claim token.
- Accept customer commands only in private Telegram chats.
- Reuse `buildApiKeyUsageAlerts`; do not duplicate quota accounting or enforcement.
- General commands: 6 per minute per chat; invalid claims: 5 per 15 minutes per chat.
- Monitor active subscriptions every 60 seconds with a non-overlap guard.
- Preserve all unrelated dirty-worktree changes and stage only task-owned files.

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

## Plan Self-Review

- Spec coverage: shared usage, secure claim linking, private-chat UX, persistence, 90/95/100 alerts, expiry alerts, anti-spam, lease, shutdown, live verification, and secret handling all have owning tasks.
- Placeholder scan: complete; every implementation step is concrete.
- Type consistency: the usage snapshot, subscription DB, claim route, bot runtime, and monitor interfaces are defined before consumers use them.
