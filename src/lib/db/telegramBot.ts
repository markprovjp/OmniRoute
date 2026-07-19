import { createHash, randomBytes, randomUUID } from "crypto";
import { getDbInstance, rowToCamel } from "./core";

const CLAIM_TTL_MS = 10 * 60 * 1000;

interface TelegramSubscriptionRow {
  id: string;
  api_key_id: string;
  chat_id: string;
  is_active: number;
  muted_until: number | null;
  created_at: number;
  updated_at: number;
  disconnected_at: number | null;
}

interface TelegramClaimRow {
  token_hash: string;
  api_key_id: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface TelegramLinkClaim {
  token: string;
  expiresAt: string;
}

export interface TelegramSubscription {
  id: string;
  apiKeyId: string;
  chatId: string;
  mutedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramAlertDeliveryUpdate {
  status: "sent" | "retry" | "failed";
  telegramMessageId?: string | null;
  errorMessage?: string | null;
  retryAt?: Date | null;
}

function hashClaim(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toMillis(value: Date): number {
  return value.getTime();
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function mapSubscription(row: TelegramSubscriptionRow): TelegramSubscription {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    chatId: row.chat_id,
    mutedUntil: toIso(row.muted_until),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createTelegramLinkClaim(apiKeyId: string, now = new Date()): TelegramLinkClaim {
  const token = randomBytes(32).toString("base64url");
  const nowMs = toMillis(now);
  const expiresAt = nowMs + CLAIM_TTL_MS;

  getDbInstance()
    .prepare(
      `INSERT INTO telegram_link_claims (token_hash, api_key_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(hashClaim(token), apiKeyId, expiresAt, nowMs);

  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeTelegramLinkClaim(
  token: string,
  chatId: string,
  now = new Date()
): TelegramSubscription | null {
  const db = getDbInstance();
  const nowMs = toMillis(now);
  const tokenHash = hashClaim(token);
  let subscription: TelegramSubscription | null = null;

  db.immediate(() => {
    const claim = db
      .prepare(
        `SELECT token_hash, api_key_id, expires_at, consumed_at, created_at
         FROM telegram_link_claims
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
      )
      .get(tokenHash, nowMs) as TelegramClaimRow | undefined;
    if (!claim) return;

    const existing = db
      .prepare(
        `SELECT id, api_key_id, chat_id, is_active, muted_until, created_at, updated_at, disconnected_at
         FROM telegram_subscriptions
         WHERE api_key_id = ?`
      )
      .get(claim.api_key_id) as TelegramSubscriptionRow | undefined;
    if (existing?.is_active) return;

    const chatOwner = db
      .prepare("SELECT api_key_id FROM telegram_subscriptions WHERE chat_id = ?")
      .get(chatId) as { api_key_id: string } | undefined;
    if (chatOwner && chatOwner.api_key_id !== claim.api_key_id) return;

    const consumed = db
      .prepare(
        `UPDATE telegram_link_claims
         SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
      )
      .run(nowMs, tokenHash, nowMs);
    if (consumed.changes !== 1) return;

    if (existing) {
      const reactivated = db
        .prepare(
          `UPDATE telegram_subscriptions
           SET chat_id = ?, is_active = 1, muted_until = NULL, updated_at = ?, disconnected_at = NULL
           WHERE id = ? AND is_active = 0`
        )
        .run(chatId, nowMs, existing.id);
      if (reactivated.changes !== 1) {
        throw new Error("Failed to reactivate Telegram subscription");
      }
    } else {
      db.prepare(
        `INSERT INTO telegram_subscriptions
         (id, api_key_id, chat_id, is_active, muted_until, created_at, updated_at, disconnected_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?, NULL)`
      ).run(randomUUID(), claim.api_key_id, chatId, nowMs, nowMs);
    }

    const row = db
      .prepare(
        `SELECT id, api_key_id, chat_id, is_active, muted_until, created_at, updated_at, disconnected_at
         FROM telegram_subscriptions
         WHERE api_key_id = ? AND is_active = 1`
      )
      .get(claim.api_key_id) as TelegramSubscriptionRow | undefined;
    subscription = row ? mapSubscription(row) : null;
  });

  return subscription;
}

export function getTelegramSubscriptionByChat(chatId: string): TelegramSubscription | null {
  const row = getDbInstance()
    .prepare(
      `SELECT id, api_key_id, chat_id, is_active, muted_until, created_at, updated_at, disconnected_at
       FROM telegram_subscriptions
       WHERE chat_id = ? AND is_active = 1`
    )
    .get(chatId) as TelegramSubscriptionRow | undefined;
  return row ? mapSubscription(row) : null;
}

export function listActiveTelegramSubscriptions(): TelegramSubscription[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT id, api_key_id, chat_id, is_active, muted_until, created_at, updated_at, disconnected_at
       FROM telegram_subscriptions
       WHERE is_active = 1
       ORDER BY created_at ASC`
    )
    .all() as TelegramSubscriptionRow[];
  return rows.map(mapSubscription);
}

export function disconnectTelegramSubscription(chatId: string, now = new Date()): boolean {
  const result = getDbInstance()
    .prepare(
      `UPDATE telegram_subscriptions
       SET is_active = 0, muted_until = NULL, updated_at = ?, disconnected_at = ?
       WHERE chat_id = ? AND is_active = 1`
    )
    .run(toMillis(now), toMillis(now), chatId);
  return result.changes === 1;
}

export function setTelegramMute(
  chatId: string,
  mutedUntil: Date | null,
  now = new Date()
): boolean {
  const result = getDbInstance()
    .prepare(
      `UPDATE telegram_subscriptions
       SET muted_until = ?, updated_at = ?
       WHERE chat_id = ? AND is_active = 1`
    )
    .run(mutedUntil ? toMillis(mutedUntil) : null, toMillis(now), chatId);
  return result.changes === 1;
}

export function reserveTelegramAlertDelivery(
  subscriptionId: string,
  dedupeKey: string,
  now = new Date()
): boolean {
  const nowMs = toMillis(now);
  const result = getDbInstance()
    .prepare(
      `INSERT OR IGNORE INTO telegram_alert_deliveries
       (id, subscription_id, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'reserved', ?, ?)`
    )
    .run(randomUUID(), subscriptionId, dedupeKey, nowMs, nowMs);
  return result.changes === 1;
}

export function recordTelegramAlertDelivery(
  subscriptionId: string,
  dedupeKey: string,
  update: TelegramAlertDeliveryUpdate,
  now = new Date()
): boolean {
  const nowMs = toMillis(now);
  const result = getDbInstance()
    .prepare(
      `UPDATE telegram_alert_deliveries
       SET status = ?, telegram_message_id = ?, error_message = ?, retry_at = ?,
           delivered_at = ?, updated_at = ?
       WHERE subscription_id = ? AND dedupe_key = ?`
    )
    .run(
      update.status,
      update.telegramMessageId ?? null,
      update.errorMessage ?? null,
      update.retryAt ? toMillis(update.retryAt) : null,
      update.status === "sent" ? nowMs : null,
      nowMs,
      subscriptionId,
      dedupeKey
    );
  return result.changes === 1;
}

export function acquireTelegramBotLease(
  ownerId: string,
  now = new Date(),
  leaseMs = 60_000
): boolean {
  const nowMs = toMillis(now);
  const result = getDbInstance()
    .prepare(
      `INSERT INTO telegram_bot_state (singleton_id, owner_id, lease_expires_at, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at
       WHERE telegram_bot_state.lease_expires_at <= ?
          OR telegram_bot_state.owner_id = excluded.owner_id`
    )
    .run(ownerId, nowMs + leaseMs, nowMs, nowMs);
  return result.changes === 1;
}

export function renewTelegramBotLease(
  ownerId: string,
  now = new Date(),
  leaseMs = 60_000
): boolean {
  const nowMs = toMillis(now);
  const result = getDbInstance()
    .prepare(
      `UPDATE telegram_bot_state
       SET lease_expires_at = ?, updated_at = ?
       WHERE singleton_id = 1 AND owner_id = ? AND lease_expires_at > ?`
    )
    .run(nowMs + leaseMs, nowMs, ownerId, nowMs);
  return result.changes === 1;
}

export function releaseTelegramBotLease(ownerId: string): boolean {
  const result = getDbInstance()
    .prepare("DELETE FROM telegram_bot_state WHERE singleton_id = 1 AND owner_id = ?")
    .run(ownerId);
  return result.changes === 1;
}

export function __testListClaims(): Array<Record<string, unknown>> {
  return getDbInstance()
    .prepare(
      "SELECT token_hash, api_key_id, expires_at, consumed_at, created_at FROM telegram_link_claims"
    )
    .all()
    .map((row) => rowToCamel(row) ?? {});
}
