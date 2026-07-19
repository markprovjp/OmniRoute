import { randomUUID } from "crypto";
import { getDbInstance } from "@/lib/db/core";
import { maskStoredApiKey } from "@/lib/apiKeyExposure";
import { dispatchApiKeyThresholdAlerts } from "@/lib/usage/apiKeyAlerts";
import { getRedisClient, isRedisEnabled } from "@/shared/utils/rateLimiter";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_OUTPUT_RESERVATION = 4096;
const REDIS_QUOTA_REQUIRED = process.env.OMNIROUTE_REDIS_QUOTA_REQUIRED === "1";
const QUOTA_CONFIG_CACHE_TTL_MS = 1_000;

interface RedisQuotaClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  status?: string;
}

let redisQuotaClientForTest: RedisQuotaClient | null | undefined;
const quotaConfigCache = new Map<string, { expiresAt: number; value: ApiKeyQuotaConfig | null }>();

export function setApiKeyQuotaRedisClientForTest(
  client: RedisQuotaClient | null | undefined
): void {
  redisQuotaClientForTest = client;
}

type QuotaWindowType = "day" | "hour";
type QuotaReason =
  | "daily_token_limit"
  | "hourly_token_limit"
  | "daily_request_limit"
  | "lifetime_token_limit"
  | "api_key_missing";

type QuotaRow = Record<string, unknown>;

interface ApiKeyQuotaConfig {
  id: string;
  tokenLimit: number | null;
  tokenUsed: number;
  dailyTokenLimit: number | null;
  hourlyTokenLimit: number | null;
  maxRequestsPerDay: number | null;
}

interface WindowSpec {
  type: QuotaWindowType;
  key: string;
  resetAt: string;
  tokenLimit: number | null;
  requestLimit: number | null;
}

export interface ApiKeyQuotaWindowSnapshot {
  id: string;
  type: QuotaWindowType;
  windowKey: string;
  tokenLimit: number | null;
  usedTokens: number;
  reservedTokens: number;
  requestLimit: number | null;
  requestCount: number;
  remainingTokens: number | null;
  remainingRequests: number | null;
  resetAt: string;
}

export interface ApiKeyQuotaSnapshot {
  day: ApiKeyQuotaWindowSnapshot | null;
  hour: ApiKeyQuotaWindowSnapshot | null;
}

export interface ApiKeyUsageLedgerEntry {
  id: string;
  apiKeyId: string;
  reservationId: string | null;
  requestId: string;
  model: string | null;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  usageSource: string;
  createdAt: string;
}

export type ApiKeyUsageReservationResult =
  | {
      allowed: true;
      reservationId: string | null;
      requestId: string;
      estimatedTokens: number;
      quota: ApiKeyQuotaSnapshot;
    }
  | {
      allowed: false;
      reason: QuotaReason;
      requestId: string;
      quota: ApiKeyQuotaSnapshot;
    };

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getApiKeyQuotaConfig(apiKeyId: string): ApiKeyQuotaConfig | null {
  const row = getDbInstance()
    .prepare(
      `
      SELECT id, token_limit, token_used, daily_token_limit, hourly_token_limit,
             max_requests_per_day
      FROM api_keys
      WHERE id = ?
    `
    )
    .get(apiKeyId) as QuotaRow | undefined;
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    tokenLimit: positiveInt(row.token_limit),
    tokenUsed: nonNegativeInt(row.token_used),
    dailyTokenLimit: positiveInt(row.daily_token_limit),
    hourlyTokenLimit: positiveInt(row.hourly_token_limit),
    maxRequestsPerDay: positiveInt(row.max_requests_per_day),
  };
}

function getApiKeyQuotaConfigCached(apiKeyId: string): ApiKeyQuotaConfig | null {
  const now = Date.now();
  const cached = quotaConfigCache.get(apiKeyId);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = getApiKeyQuotaConfig(apiKeyId);
  quotaConfigCache.set(apiKeyId, { expiresAt: now + QUOTA_CONFIG_CACHE_TTL_MS, value });

  if (quotaConfigCache.size > 2_000) {
    for (const [key, entry] of quotaConfigCache) {
      if (entry.expiresAt <= now || quotaConfigCache.size > 1_500) quotaConfigCache.delete(key);
    }
  }

  return value;
}

function getWindowSpecs(config: ApiKeyQuotaConfig, now = new Date()): WindowSpec[] {
  const bangkok = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const year = bangkok.getUTCFullYear();
  const month = bangkok.getUTCMonth();
  const day = bangkok.getUTCDate();
  const hour = bangkok.getUTCHours();
  const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hourKey = `${dateKey}T${String(hour).padStart(2, "0")}`;
  const dayReset = new Date(Date.UTC(year, month, day + 1) - BANGKOK_OFFSET_MS);
  const hourReset = new Date(Date.UTC(year, month, day, hour + 1) - BANGKOK_OFFSET_MS);

  const specs: WindowSpec[] = [
    {
      type: "day",
      key: dateKey,
      resetAt: dayReset.toISOString(),
      tokenLimit: config.dailyTokenLimit,
      requestLimit: config.maxRequestsPerDay,
    },
    {
      type: "hour",
      key: hourKey,
      resetAt: hourReset.toISOString(),
      tokenLimit: config.hourlyTokenLimit,
      requestLimit: null,
    },
  ];

  return specs.filter((spec) => spec.tokenLimit !== null || spec.requestLimit !== null);
}

function mapWindow(row: QuotaRow | undefined): ApiKeyQuotaWindowSnapshot | null {
  const id = toStringOrNull(row?.id);
  const type = row?.window_type === "day" || row?.window_type === "hour" ? row.window_type : null;
  const windowKey = toStringOrNull(row?.window_key);
  const resetAt = toStringOrNull(row?.reset_at);
  if (!id || !type || !windowKey || !resetAt) return null;
  const tokenLimit = positiveInt(row?.token_limit);
  const requestLimit = positiveInt(row?.request_limit);
  const usedTokens = nonNegativeInt(row?.used_tokens);
  const reservedTokens = nonNegativeInt(row?.reserved_tokens);
  const requestCount = nonNegativeInt(row?.request_count);
  return {
    id,
    type,
    windowKey,
    tokenLimit,
    usedTokens,
    reservedTokens,
    requestLimit,
    requestCount,
    remainingTokens:
      tokenLimit === null ? null : Math.max(0, tokenLimit - usedTokens - reservedTokens),
    remainingRequests: requestLimit === null ? null : Math.max(0, requestLimit - requestCount),
    resetAt,
  };
}

function mapSnapshot(rows: QuotaRow[]): ApiKeyQuotaSnapshot {
  return rows.reduce<ApiKeyQuotaSnapshot>(
    (snapshot, row) => {
      const mapped = mapWindow(row);
      if (mapped) snapshot[mapped.type] = mapped;
      return snapshot;
    },
    { day: null, hour: null }
  );
}

function getSnapshotRows(apiKeyId: string, now = new Date()): QuotaRow[] {
  const config = getApiKeyQuotaConfig(apiKeyId);
  if (!config) return [];
  const specs = getWindowSpecs(config, now);
  if (specs.length === 0) return [];
  const rows = getDbInstance()
    .prepare(
      `
      SELECT *
      FROM api_key_quota_windows
      WHERE api_key_id = @apiKeyId
        AND (
          (window_type = 'day' AND window_key = @dayKey) OR
          (window_type = 'hour' AND window_key = @hourKey)
        )
    `
    )
    .all({
      apiKeyId,
      dayKey: specs.find((spec) => spec.type === "day")?.key || "",
      hourKey: specs.find((spec) => spec.type === "hour")?.key || "",
    }) as QuotaRow[];
  return rows;
}

function getActiveReservedTokens(
  db: ReturnType<typeof getDbInstance>,
  apiKeyId: string,
  nowIso: string
): number {
  const row = db
    .prepare(
      `
      SELECT COALESCE(SUM(estimated_tokens), 0) AS reserved_tokens
      FROM api_key_usage_reservations
      WHERE api_key_id = @apiKeyId
        AND state = 'reserved'
        AND expires_at > @now
    `
    )
    .get({ apiKeyId, now: nowIso }) as QuotaRow | undefined;
  return nonNegativeInt(row?.reserved_tokens);
}

export function getApiKeyQuotaSnapshot(apiKeyId: string, now = new Date()): ApiKeyQuotaSnapshot {
  return mapSnapshot(getSnapshotRows(apiKeyId, now));
}

export function getApiKeyQuotaSnapshots(apiKeyIds: string[]): Record<string, ApiKeyQuotaSnapshot> {
  return Object.fromEntries(
    Array.from(new Set(apiKeyIds.filter((id) => typeof id === "string" && id.trim()))).map((id) => [
      id,
      getApiKeyQuotaSnapshot(id),
    ])
  );
}

function materializeWindow(
  db: ReturnType<typeof getDbInstance>,
  apiKeyId: string,
  spec: WindowSpec
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO api_key_quota_windows
      (id, api_key_id, window_type, window_key, token_limit, request_limit, reset_at, created_at, updated_at)
    VALUES
      (@id, @apiKeyId, @type, @key, @tokenLimit, @requestLimit, @resetAt, @now, @now)
    ON CONFLICT(api_key_id, window_type, window_key) DO NOTHING
  `
  ).run({ id, apiKeyId, ...spec, now });
  db.prepare(
    `
    UPDATE api_key_quota_windows
    SET token_limit = @tokenLimit,
        request_limit = @requestLimit,
        reset_at = @resetAt,
        updated_at = @now
    WHERE api_key_id = @apiKeyId AND window_type = @type AND window_key = @key
  `
  ).run({ apiKeyId, ...spec, now });
  return db
    .prepare(
      "SELECT * FROM api_key_quota_windows WHERE api_key_id = ? AND window_type = ? AND window_key = ?"
    )
    .get(apiKeyId, spec.type, spec.key) as QuotaRow;
}

function expireReservations(db: ReturnType<typeof getDbInstance>, nowIso: string): void {
  const stale = db
    .prepare(
      `
      SELECT id, estimated_tokens
      FROM api_key_usage_reservations
      WHERE state = 'reserved' AND expires_at <= @now
    `
    )
    .all({ now: nowIso }) as QuotaRow[];

  for (const reservation of stale) {
    const id = toStringOrNull(reservation.id);
    if (!id) continue;
    db.prepare(
      `
      UPDATE api_key_quota_windows
      SET reserved_tokens = MAX(0, reserved_tokens - @estimatedTokens), updated_at = @now
      WHERE id IN (
        SELECT quota_window_id
        FROM api_key_usage_reservation_windows
        WHERE reservation_id = @reservationId
      )
    `
    ).run({
      reservationId: id,
      estimatedTokens: nonNegativeInt(reservation.estimated_tokens),
      now: nowIso,
    });
    db.prepare(
      `
      UPDATE api_key_usage_reservations
      SET state = 'expired', released_at = @now, release_reason = 'reservation_ttl', updated_at = @now
      WHERE id = @reservationId AND state = 'reserved'
    `
    ).run({ reservationId: id, now: nowIso });
  }
}

export function expireApiKeyUsageReservations(now = new Date()): void {
  const db = getDbInstance();
  db.transaction(() => expireReservations(db, now.toISOString()))();
}

function quotaFailureForWindow(
  row: QuotaRow,
  spec: WindowSpec,
  estimatedTokens: number
): QuotaReason {
  const requestLimit = positiveInt(row.request_limit);
  if (
    spec.type === "day" &&
    requestLimit !== null &&
    nonNegativeInt(row.request_count) >= requestLimit
  ) {
    return "daily_request_limit";
  }
  const tokenLimit = positiveInt(row.token_limit);
  const available =
    tokenLimit === null
      ? Number.POSITIVE_INFINITY
      : tokenLimit - nonNegativeInt(row.used_tokens) - nonNegativeInt(row.reserved_tokens);
  if (available < estimatedTokens) {
    return spec.type === "hour" ? "hourly_token_limit" : "daily_token_limit";
  }
  return spec.type === "hour" ? "hourly_token_limit" : "daily_token_limit";
}

function readReservation(id: string): QuotaRow | null {
  return (
    (getDbInstance().prepare("SELECT * FROM api_key_usage_reservations WHERE id = ?").get(id) as
      | QuotaRow
      | undefined) || null
  );
}

const REDIS_RESERVE_SCRIPT = `
local estimated = tonumber(ARGV[1]) or 0
local token_limit = tonumber(ARGV[2]) or -1
local token_used_seed = tonumber(ARGV[3]) or 0
local day_limit = tonumber(ARGV[4]) or -1
local day_used_seed = tonumber(ARGV[5]) or 0
local day_reserved_seed = tonumber(ARGV[6]) or 0
local day_request_limit = tonumber(ARGV[7]) or -1
local day_request_seed = tonumber(ARGV[8]) or 0
local day_ttl = tonumber(ARGV[9]) or 0
local hour_limit = tonumber(ARGV[10]) or -1
local hour_used_seed = tonumber(ARGV[11]) or 0
local hour_reserved_seed = tonumber(ARGV[12]) or 0
local hour_ttl = tonumber(ARGV[13]) or 0

local function ensure(key, value, ttl)
  if redis.call("EXISTS", key) == 0 then
    redis.call("SET", key, value)
  end
  if ttl > 0 and redis.call("TTL", key) < 0 then
    redis.call("EXPIRE", key, ttl)
  end
end

ensure(KEYS[1], token_used_seed, 0)
ensure(KEYS[2], 0, 0)
ensure(KEYS[3], day_used_seed, day_ttl)
ensure(KEYS[4], day_reserved_seed, day_ttl)
ensure(KEYS[5], day_request_seed, day_ttl)
ensure(KEYS[6], hour_used_seed, hour_ttl)
ensure(KEYS[7], hour_reserved_seed, hour_ttl)

local life_used = tonumber(redis.call("GET", KEYS[1]) or "0")
local life_reserved = tonumber(redis.call("GET", KEYS[2]) or "0")
if token_limit >= 0 and (life_used + life_reserved + estimated) > token_limit then
  return {0, "lifetime_token_limit"}
end

local day_requests = tonumber(redis.call("GET", KEYS[5]) or "0")
if day_request_limit >= 0 and day_requests >= day_request_limit then
  return {0, "daily_request_limit"}
end

local day_used = tonumber(redis.call("GET", KEYS[3]) or "0")
local day_reserved = tonumber(redis.call("GET", KEYS[4]) or "0")
if day_limit >= 0 and (day_used + day_reserved + estimated) > day_limit then
  return {0, "daily_token_limit"}
end

local hour_used = tonumber(redis.call("GET", KEYS[6]) or "0")
local hour_reserved = tonumber(redis.call("GET", KEYS[7]) or "0")
if hour_limit >= 0 and (hour_used + hour_reserved + estimated) > hour_limit then
  return {0, "hourly_token_limit"}
end

redis.call("INCRBY", KEYS[2], estimated)
redis.call("INCRBY", KEYS[4], estimated)
redis.call("INCRBY", KEYS[5], 1)
redis.call("INCRBY", KEYS[7], estimated)
return {1, "ok"}
`;

const REDIS_SETTLE_SCRIPT = `
local estimated = tonumber(ARGV[1]) or 0
local actual = tonumber(ARGV[2]) or estimated
local function move(reserved_key, used_key)
  local reserved = tonumber(redis.call("GET", reserved_key) or "0")
  redis.call("SET", reserved_key, math.max(0, reserved - estimated))
  redis.call("INCRBY", used_key, actual)
end
move(KEYS[2], KEYS[1])
move(KEYS[4], KEYS[3])
move(KEYS[7], KEYS[6])
return {1, "ok"}
`;

const REDIS_RELEASE_SCRIPT = `
local estimated = tonumber(ARGV[1]) or 0
local function release(reserved_key)
  local reserved = tonumber(redis.call("GET", reserved_key) or "0")
  redis.call("SET", reserved_key, math.max(0, reserved - estimated))
end
release(KEYS[2])
release(KEYS[4])
release(KEYS[7])
return {1, "ok"}
`;

function getRedisQuotaClient(): RedisQuotaClient | null {
  if (redisQuotaClientForTest !== undefined) return redisQuotaClientForTest;
  if (!isRedisEnabled()) return null;
  const client = getRedisClient() as RedisQuotaClient | null;
  const status = client?.status;
  const usableStatuses = new Set(["ready", "connect", "connecting", "reconnecting"]);
  if (status && !usableStatuses.has(status)) {
    if (REDIS_QUOTA_REQUIRED) {
      throw new Error(`Redis quota guard is required but Redis is ${status}`);
    }
    return null;
  }
  return client;
}

function secondsUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(60, Math.ceil(ms / 1000) + 300);
}

function redisQuotaKeys(apiKeyId: string, specs: WindowSpec[]) {
  const day = specs.find((spec) => spec.type === "day");
  const hour = specs.find((spec) => spec.type === "hour");
  return [
    `quota:api_key:${apiKeyId}:life:used`,
    `quota:api_key:${apiKeyId}:life:reserved`,
    `quota:api_key:${apiKeyId}:day:${day?.key || "none"}:used`,
    `quota:api_key:${apiKeyId}:day:${day?.key || "none"}:reserved`,
    `quota:api_key:${apiKeyId}:day:${day?.key || "none"}:requests`,
    `quota:api_key:${apiKeyId}:hour:${hour?.key || "none"}:used`,
    `quota:api_key:${apiKeyId}:hour:${hour?.key || "none"}:reserved`,
  ];
}

function readWindowSeed(apiKeyId: string, type: QuotaWindowType, key: string): QuotaRow | null {
  return (
    (getDbInstance()
      .prepare(
        "SELECT * FROM api_key_quota_windows WHERE api_key_id = ? AND window_type = ? AND window_key = ?"
      )
      .get(apiKeyId, type, key) as QuotaRow | undefined) || null
  );
}

function getRedisReservationSpecs(apiKeyId: string, reservationId: string): WindowSpec[] {
  const rows = getDbInstance()
    .prepare(
      `
      SELECT window_type, window_key, token_limit, request_limit, reset_at
      FROM api_key_quota_windows
      WHERE api_key_id = @apiKeyId
        AND id IN (
          SELECT quota_window_id
          FROM api_key_usage_reservation_windows
          WHERE reservation_id = @reservationId
        )
    `
    )
    .all({ apiKeyId, reservationId }) as QuotaRow[];

  return rows.flatMap((row) => {
    const type = row.window_type === "day" || row.window_type === "hour" ? row.window_type : null;
    const key = toStringOrNull(row.window_key);
    const resetAt = toStringOrNull(row.reset_at);
    if (!type || !key || !resetAt) return [];
    return [
      {
        type,
        key,
        resetAt,
        tokenLimit: positiveInt(row.token_limit),
        requestLimit: positiveInt(row.request_limit),
      },
    ];
  });
}

async function reserveRedisQuota(input: {
  config: ApiKeyQuotaConfig;
  specs: WindowSpec[];
  estimatedTokens: number;
}): Promise<QuotaReason | null> {
  const redis = getRedisQuotaClient();
  if (!redis) return null;
  const day = input.specs.find((spec) => spec.type === "day");
  const hour = input.specs.find((spec) => spec.type === "hour");
  const daySeed = day ? readWindowSeed(input.config.id, "day", day.key) : null;
  const hourSeed = hour ? readWindowSeed(input.config.id, "hour", hour.key) : null;
  const args = [
    input.estimatedTokens,
    input.config.tokenLimit ?? -1,
    input.config.tokenUsed,
    day?.tokenLimit ?? -1,
    nonNegativeInt(daySeed?.used_tokens),
    nonNegativeInt(daySeed?.reserved_tokens),
    day?.requestLimit ?? -1,
    nonNegativeInt(daySeed?.request_count),
    day ? secondsUntil(day.resetAt) : 60,
    hour?.tokenLimit ?? -1,
    nonNegativeInt(hourSeed?.used_tokens),
    nonNegativeInt(hourSeed?.reserved_tokens),
    hour ? secondsUntil(hour.resetAt) : 60,
  ];
  try {
    const result = (await redis.eval(
      REDIS_RESERVE_SCRIPT,
      7,
      ...redisQuotaKeys(input.config.id, input.specs),
      ...args
    )) as [number, string];
    return Number(result?.[0]) === 1 ? null : (result?.[1] as QuotaReason) || "daily_token_limit";
  } catch (error) {
    if (REDIS_QUOTA_REQUIRED) throw error;
    console.warn(
      "[ApiKeyQuotaLedger] Redis quota reservation failed; falling back to SQLite:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

async function syncRedisQuotaKeys(input: {
  apiKeyId: string;
  specs: WindowSpec[];
  mode: "settle" | "release";
  estimatedTokens: number;
  actualTokens?: number | null;
}): Promise<void> {
  const redis = getRedisQuotaClient();
  if (!redis) return;
  const script = input.mode === "settle" ? REDIS_SETTLE_SCRIPT : REDIS_RELEASE_SCRIPT;
  const actualTokens = Math.max(
    0,
    Math.floor(Number(input.actualTokens ?? input.estimatedTokens) || 0)
  );
  try {
    await redis.eval(
      script,
      7,
      ...redisQuotaKeys(input.apiKeyId, input.specs),
      input.estimatedTokens,
      actualTokens
    );
  } catch (error) {
    if (REDIS_QUOTA_REQUIRED) throw error;
    console.warn(
      "[ApiKeyQuotaLedger] Redis quota sync failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function syncRedisReservation(input: {
  reservationId: string;
  mode: "settle" | "release";
  actualTokens?: number | null;
}): Promise<void> {
  const reservation = readReservation(input.reservationId);
  if (!reservation) return;
  const apiKeyId = toStringOrNull(reservation.api_key_id);
  if (!apiKeyId) return;
  const config = getApiKeyQuotaConfig(apiKeyId);
  if (!config) return;
  const reservationSpecs = getRedisReservationSpecs(apiKeyId, input.reservationId);
  await syncRedisQuotaKeys({
    apiKeyId,
    specs: reservationSpecs.length > 0 ? reservationSpecs : getWindowSpecs(config),
    mode: input.mode,
    estimatedTokens: nonNegativeInt(reservation.estimated_tokens),
    actualTokens: input.actualTokens,
  });
}

export async function reserveApiKeyUsageDistributed(input: {
  apiKeyId: string;
  estimatedTokens: number;
  requestId?: string | null;
  model?: string | null;
  now?: Date;
}): Promise<ApiKeyUsageReservationResult> {
  const requestId = input.requestId || `req_${randomUUID()}`;
  const estimatedTokens = Math.max(0, Math.floor(Number(input.estimatedTokens) || 0));
  const now = input.now || new Date();
  const config = isRedisEnabled()
    ? getApiKeyQuotaConfigCached(input.apiKeyId)
    : getApiKeyQuotaConfig(input.apiKeyId);
  if (!config) {
    return {
      allowed: false,
      reason: "api_key_missing",
      requestId,
      quota: { day: null, hour: null },
    };
  }
  const specs = getWindowSpecs(config, now);
  const redisRejection = await reserveRedisQuota({ config, specs, estimatedTokens });
  if (redisRejection) {
    return {
      allowed: false,
      reason: redisRejection,
      requestId,
      quota: getApiKeyQuotaSnapshot(config.id, now),
    };
  }
  const result = reserveApiKeyUsage({ ...input, requestId, estimatedTokens, now });
  if (!result.allowed && getRedisQuotaClient()) {
    await syncRedisQuotaKeys({
      apiKeyId: config.id,
      specs,
      mode: "release",
      estimatedTokens,
    }).catch(() => undefined);
  }
  return result;
}
export function reserveApiKeyUsage(input: {
  apiKeyId: string;
  estimatedTokens: number;
  requestId?: string | null;
  model?: string | null;
  now?: Date;
}): ApiKeyUsageReservationResult {
  const requestId = input.requestId || `req_${randomUUID()}`;
  const estimatedTokens = Math.max(0, Math.floor(Number(input.estimatedTokens) || 0));
  const now = input.now || new Date();
  const config = getApiKeyQuotaConfig(input.apiKeyId);
  if (!config) {
    return {
      allowed: false,
      reason: "api_key_missing",
      requestId,
      quota: { day: null, hour: null },
    };
  }

  const specs = getWindowSpecs(config, now);
  if (specs.length === 0 && config.tokenLimit === null) {
    return {
      allowed: true,
      reservationId: null,
      requestId,
      estimatedTokens,
      quota: { day: null, hour: null },
    };
  }

  const db = getDbInstance();
  let rejected: QuotaReason | null = null;
  let reservationId: string | null = null;
  try {
    db.transaction(() => {
      const nowIso = now.toISOString();
      expireReservations(db, nowIso);
      if (
        config.tokenLimit !== null &&
        config.tokenUsed + getActiveReservedTokens(db, config.id, nowIso) + estimatedTokens >
          config.tokenLimit
      ) {
        rejected = "lifetime_token_limit";
        throw new Error("quota_reservation_rejected");
      }
      const windows = specs.map((spec) => ({ spec, row: materializeWindow(db, config.id, spec) }));
      for (const { spec, row } of windows) {
        const result = db
          .prepare(
            `
          UPDATE api_key_quota_windows
          SET reserved_tokens = reserved_tokens + @tokens,
              request_count = request_count + 1,
              updated_at = @now
          WHERE id = @id
            AND (token_limit IS NULL OR (token_limit - used_tokens - reserved_tokens) >= @tokens)
            AND (request_limit IS NULL OR request_count < request_limit)
        `
          )
          .run({ id: row.id, tokens: estimatedTokens, now: nowIso });
        if ((result.changes ?? 0) === 0) {
          rejected = quotaFailureForWindow(row, spec, estimatedTokens);
          throw new Error("quota_reservation_rejected");
        }
      }

      reservationId = randomUUID();
      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
      db.prepare(
        `
        INSERT INTO api_key_usage_reservations
          (id, api_key_id, request_id, model, estimated_tokens, state, expires_at, created_at, updated_at)
        VALUES
          (@id, @apiKeyId, @requestId, @model, @estimatedTokens, 'reserved', @expiresAt, @now, @now)
      `
      ).run({
        id: reservationId,
        apiKeyId: config.id,
        requestId,
        model: input.model || null,
        estimatedTokens,
        expiresAt,
        now: nowIso,
      });
      for (const { row } of windows) {
        db.prepare(
          `
          INSERT INTO api_key_usage_reservation_windows (reservation_id, quota_window_id)
          VALUES (?, ?)
        `
        ).run(reservationId, row.id);
      }
    })();
  } catch (error) {
    if (!rejected) throw error;
  }

  if (!reservationId) {
    return {
      allowed: false,
      reason: rejected || "daily_token_limit",
      requestId,
      quota: getApiKeyQuotaSnapshot(config.id, now),
    };
  }

  return {
    allowed: true,
    reservationId,
    requestId,
    estimatedTokens,
    quota: getApiKeyQuotaSnapshot(config.id, now),
  };
}

export function settleApiKeyUsageReservation(input: {
  reservationId: string;
  actualTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  usageSource?: string | null;
}): ApiKeyQuotaSnapshot | null {
  const reservation = readReservation(input.reservationId);
  if (!reservation || reservation.state !== "reserved") return null;
  const apiKeyId = toStringOrNull(reservation.api_key_id);
  if (!apiKeyId) return null;
  const estimatedTokens = nonNegativeInt(reservation.estimated_tokens);
  const actualTokens = Math.max(0, Math.floor(Number(input.actualTokens ?? estimatedTokens) || 0));
  const inputTokens = Math.max(0, Math.floor(Number(input.inputTokens ?? 0) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(input.outputTokens ?? 0) || 0));
  const usageSource = input.usageSource || (input.actualTokens == null ? "estimated" : "actual");
  const db = getDbInstance();
  let keyAlertContext:
    | {
        name: string | null;
        key: string | null;
        expiresAt: string | null;
        tokenLimit: number | null;
        tokenUsed: number;
      }
    | undefined;
  db.transaction(() => {
    const now = new Date().toISOString();
    const current = db
      .prepare("SELECT * FROM api_key_usage_reservations WHERE id = ?")
      .get(input.reservationId) as QuotaRow | undefined;
    if (!current || current.state !== "reserved") return;
    const windows = db
      .prepare(
        `
        SELECT quota_window_id
        FROM api_key_usage_reservation_windows
        WHERE reservation_id = ?
      `
      )
      .all(input.reservationId) as QuotaRow[];
    for (const window of windows) {
      const quotaWindowId = toStringOrNull(window.quota_window_id);
      if (!quotaWindowId) continue;
      db.prepare(
        `
        UPDATE api_key_quota_windows
        SET reserved_tokens = MAX(0, reserved_tokens - @estimatedTokens),
            used_tokens = used_tokens + @actualTokens,
            updated_at = @now
        WHERE id = @quotaWindowId
      `
      ).run({ quotaWindowId, estimatedTokens, actualTokens, now });
    }
    db.prepare(
      `
      UPDATE api_keys
      SET token_used = COALESCE(token_used, 0) + @actualTokens
      WHERE id = @apiKeyId
    `
    ).run({ apiKeyId, actualTokens });
    const keyRow = db
      .prepare(
        `
        SELECT name, key, expires_at, token_limit, token_used
        FROM api_keys
        WHERE id = ?
      `
      )
      .get(apiKeyId) as QuotaRow | undefined;
    keyAlertContext = {
      name: toStringOrNull(keyRow?.name),
      key: toStringOrNull(keyRow?.key),
      expiresAt: toStringOrNull(keyRow?.expires_at),
      tokenLimit: positiveInt(keyRow?.token_limit),
      tokenUsed: nonNegativeInt(keyRow?.token_used),
    };
    db.prepare(
      `
      UPDATE api_key_usage_reservations
      SET state = 'settled', actual_tokens = @actualTokens, input_tokens = @inputTokens,
          output_tokens = @outputTokens, usage_source = @usageSource,
          settled_at = @now, updated_at = @now
      WHERE id = @reservationId AND state = 'reserved'
    `
    ).run({
      reservationId: input.reservationId,
      actualTokens,
      inputTokens,
      outputTokens,
      usageSource,
      now,
    });
    db.prepare(
      `
      INSERT INTO api_key_usage_ledger
        (id, api_key_id, reservation_id, quota_window_id, request_id, model, tokens,
         input_tokens, output_tokens, usage_source, created_at)
      VALUES
        (@id, @apiKeyId, @reservationId, @quotaWindowId, @requestId, @model, @tokens,
         @inputTokens, @outputTokens, @usageSource, @now)
    `
    ).run({
      id: randomUUID(),
      apiKeyId,
      reservationId: input.reservationId,
      quotaWindowId: toStringOrNull(windows[0]?.quota_window_id),
      requestId: toStringOrNull(current.request_id) || `req_${input.reservationId}`,
      model: toStringOrNull(current.model),
      tokens: actualTokens,
      inputTokens,
      outputTokens,
      usageSource,
      now,
    });
  })();
  void syncRedisReservation({
    reservationId: input.reservationId,
    mode: "settle",
    actualTokens,
  });
  const snapshot = getApiKeyQuotaSnapshot(apiKeyId);
  if (keyAlertContext) {
    void dispatchApiKeyThresholdAlerts({
      apiKeyId,
      apiKeyName: keyAlertContext.name,
      maskedKey: keyAlertContext.key ? maskStoredApiKey(keyAlertContext.key) : null,
      dailyTokenLimit: snapshot.day?.tokenLimit ?? null,
      dailyTokenUsed: snapshot.day?.usedTokens ?? null,
      dailyReservedTokens: snapshot.day?.reservedTokens ?? 0,
      dailyResetAt: snapshot.day?.resetAt ?? null,
      lifetimeTokenLimit: keyAlertContext.tokenLimit,
      lifetimeTokenUsed: keyAlertContext.tokenUsed,
      expiresAt: keyAlertContext.expiresAt,
    });
  }
  return snapshot;
}

export function releaseApiKeyUsageReservation(
  reservationId: string,
  reason = "request_failed"
): ApiKeyQuotaSnapshot | null {
  const reservation = readReservation(reservationId);
  if (!reservation || reservation.state !== "reserved") return null;
  const apiKeyId = toStringOrNull(reservation.api_key_id);
  if (!apiKeyId) return null;
  const estimatedTokens = nonNegativeInt(reservation.estimated_tokens);
  const db = getDbInstance();
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      `
      UPDATE api_key_quota_windows
      SET reserved_tokens = MAX(0, reserved_tokens - @estimatedTokens), updated_at = @now
      WHERE id IN (
        SELECT quota_window_id
        FROM api_key_usage_reservation_windows
        WHERE reservation_id = @reservationId
      )
    `
    ).run({ reservationId, estimatedTokens, now });
    db.prepare(
      `
      UPDATE api_key_usage_reservations
      SET state = 'released', released_at = @now, release_reason = @reason, updated_at = @now
      WHERE id = @reservationId AND state = 'reserved'
    `
    ).run({ reservationId, reason, now });
  })();
  void syncRedisReservation({ reservationId, mode: "release" });
  return getApiKeyQuotaSnapshot(apiKeyId);
}

export function getApiKeyUsageLedger(apiKeyId: string, limit = 50): ApiKeyUsageLedgerEntry[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  const rows = getDbInstance()
    .prepare(
      `
      SELECT id, api_key_id, reservation_id, request_id, model, tokens, input_tokens,
             output_tokens, usage_source, created_at
      FROM api_key_usage_ledger
      WHERE api_key_id = @apiKeyId
      ORDER BY created_at DESC
      LIMIT @limit
    `
    )
    .all({ apiKeyId, limit: safeLimit }) as QuotaRow[];
  return rows.map((row) => ({
    id: String(row.id),
    apiKeyId: String(row.api_key_id),
    reservationId: toStringOrNull(row.reservation_id),
    requestId: String(row.request_id),
    model: toStringOrNull(row.model),
    tokens: nonNegativeInt(row.tokens),
    inputTokens: nonNegativeInt(row.input_tokens),
    outputTokens: nonNegativeInt(row.output_tokens),
    usageSource: toStringOrNull(row.usage_source) || "actual",
    createdAt: String(row.created_at),
  }));
}

function estimateContentTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + estimateContentTokens(entry), 0);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, entry) => total + estimateContentTokens(entry),
      0
    );
  }
  return Math.ceil(String(value).length / 4);
}

export function estimateApiKeyReservationTokens(body: Record<string, unknown>): number {
  const requestedOutput = positiveInt(
    body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens
  );
  const inputTokens = Math.max(
    1,
    estimateContentTokens(body.messages) +
      estimateContentTokens(body.input) +
      estimateContentTokens(body.instructions)
  );
  return inputTokens + (requestedOutput || DEFAULT_OUTPUT_RESERVATION);
}
