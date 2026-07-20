/**
 * db/apiKeys.js — API key management.
 */

import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { getDbInstance, rowToCamel } from "./core";
import { backupDbFile } from "./backup";
import { registerDbStateResetter } from "./stateReset";
import { setNoLog } from "../compliance";
import {
  DEFAULT_IMAGE_GENERATION_POLICY,
  IMAGE_GENERATION_ALLOWED_SIZES,
} from "@/shared/constants/imageGeneration";

// ──────────────── Performance Optimizations ────────────────

// Schema check memoization - only run once
let _schemaChecked = false;

type JsonRecord = Record<string, unknown>;

interface CacheEntry<TValue> {
  timestamp: number;
  value: TValue;
}

export interface RateLimitRule {
  limit: number;
  window: number;
}

export interface AccessSchedule {
  enabled: boolean;
  from: string;
  until: string;
  days: number[];
  tz: string;
}

export interface CreateApiKeyOptions {
  scopes?: string[];
  customerName?: string | null;
  internalNote?: string | null;
  tokenLimit?: number | null;
  dailyTokenLimit?: number | null;
  hourlyTokenLimit?: number | null;
  maxRequestsPerDay?: number | null;
  maxRequestsPerMinute?: number | null;
  expiresAt?: string | null;
  commercialKey?: boolean;
  imageGenerationEnabled?: boolean;
  imageMaxRequestsPerMinute?: number;
  imageMaxRequestsPerDay?: number;
  imageMaxConcurrent?: number;
  imageAllowHighQuality?: boolean;
  imageAllowedSizes?: string[];
}

export interface ApiKeyCustomerUsageMetadata {
  id: string;
  name: string;
  keyPrefix: string | null;
  isActive: boolean;
  isBanned: boolean;
  expiresAt: string | null;
  maxRequestsPerDay: number | null;
  tokenLimit: number | null;
  dailyTokenLimit: number | null;
  hourlyTokenLimit: number | null;
  tokenUsed: number;
}

interface ApiKeyMetadata {
  id: string;
  name: string;
  machineId: string | null;
  allowedModels: string[];
  allowedConnections: string[];
  noLog: boolean;
  autoResolve: boolean;
  isActive: boolean;
  accessSchedule: AccessSchedule | null;
  maxRequestsPerDay: number | null;
  maxRequestsPerMinute: number | null;
  rateLimits: RateLimitRule[] | null;
  // T08: Per-key max concurrent sticky sessions (0 = unlimited)
  maxSessions: number;
  // Phase 3 lifecycle/policy fields
  revokedAt: string | null;
  expiresAt: string | null;
  ipAllowlist: string[];
  scopes: string[];
  isBanned: boolean;
  keyHash: string | null;
  customerName: string | null;
  internalNote: string | null;
  tokenLimit: number | null;
  dailyTokenLimit: number | null;
  hourlyTokenLimit: number | null;
  tokenUsed: number;
  commercialKey: boolean;
  imageGenerationEnabled: boolean;
  imageMaxRequestsPerMinute: number;
  imageMaxRequestsPerDay: number;
  imageMaxConcurrent: number;
  imageAllowHighQuality: boolean;
  imageAllowedSizes: string[];
}

interface ApiKeyRow extends JsonRecord {
  id?: unknown;
  name?: unknown;
  key?: unknown;
  machine_id?: unknown;
  machineId?: unknown;
  allowed_models?: unknown;
  allowedModels?: unknown;
  allowed_connections?: unknown;
  allowedConnections?: unknown;
  no_log?: unknown;
  noLog?: unknown;
  auto_resolve?: unknown;
  autoResolve?: unknown;
  is_active?: unknown;
  isActive?: unknown;
  access_schedule?: unknown;
  accessSchedule?: unknown;
  rate_limits?: unknown;
  rateLimits?: unknown;
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface ApiKeysDbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  exec: (sql: string) => void;
}

interface ApiKeysStatements {
  getAllKeys: StatementLike<ApiKeyRow>;
  getKeyById: StatementLike<ApiKeyRow>;
  getKeyCustomerUsageMetadataById: StatementLike<ApiKeyRow>;
  validateKey: StatementLike<JsonRecord>;
  getKeyMetadata: StatementLike<ApiKeyRow>;
  insertKey: StatementLike;
  deleteKey: StatementLike;
}

interface ApiKeyView extends JsonRecord {
  id?: string;
  allowedModels: string[];
  allowedConnections: string[];
  noLog: boolean;
  autoResolve: boolean;
  isActive: boolean;
  accessSchedule: AccessSchedule | null;
  rateLimits: RateLimitRule[] | null;
  imageGenerationEnabled: boolean;
  imageMaxRequestsPerMinute: number;
  imageMaxRequestsPerDay: number;
  imageMaxConcurrent: number;
  imageAllowHighQuality: boolean;
  imageAllowedSizes: string[];
}

// LRU cache for API key validation (valid keys only)
const _keyValidationCache = new Map<string, { valid: boolean; timestamp: number }>();
const _keyMetadataCache = new Map<string, CacheEntry<ApiKeyMetadata>>();
const _lastUsedUpdateCache = new Map<string, number>();
const CACHE_TTL = 60 * 1000; // 1 minute TTL
const LAST_USED_UPDATE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

// Wildcard scope matching is now handled by `matchesWildcardPattern`
// (deterministic, no RegExp from dynamic strings).

const API_KEY_COLUMN_FALLBACKS = [
  { name: "allowed_models", definition: "allowed_models TEXT" },
  { name: "no_log", definition: "no_log INTEGER NOT NULL DEFAULT 0" },
  { name: "allowed_connections", definition: "allowed_connections TEXT" },
  { name: "auto_resolve", definition: "auto_resolve INTEGER NOT NULL DEFAULT 0" },
  { name: "is_active", definition: "is_active INTEGER NOT NULL DEFAULT 1" },
  { name: "access_schedule", definition: "access_schedule TEXT" },
  { name: "max_requests_per_day", definition: "max_requests_per_day INTEGER" },
  { name: "max_requests_per_minute", definition: "max_requests_per_minute INTEGER" },
  { name: "max_sessions", definition: "max_sessions INTEGER NOT NULL DEFAULT 0" },
  { name: "revoked_at", definition: "revoked_at TEXT" },
  { name: "expires_at", definition: "expires_at TEXT" },
  { name: "last_used_at", definition: "last_used_at TEXT" },
  { name: "key_prefix", definition: "key_prefix TEXT" },
  { name: "ip_allowlist", definition: "ip_allowlist TEXT" },
  { name: "scopes", definition: "scopes TEXT" },
  { name: "rate_limits", definition: "rate_limits TEXT" },
  { name: "is_banned", definition: "is_banned INTEGER NOT NULL DEFAULT 0" },
  { name: "key_hash", definition: "key_hash TEXT" },
  { name: "customer_name", definition: "customer_name TEXT" },
  { name: "internal_note", definition: "internal_note TEXT" },
  { name: "token_limit", definition: "token_limit INTEGER" },
  { name: "daily_token_limit", definition: "daily_token_limit INTEGER" },
  { name: "hourly_token_limit", definition: "hourly_token_limit INTEGER" },
  { name: "token_used", definition: "token_used INTEGER NOT NULL DEFAULT 0" },
  { name: "commercial_key", definition: "commercial_key INTEGER NOT NULL DEFAULT 0" },
  {
    name: "image_generation_enabled",
    definition: "image_generation_enabled INTEGER NOT NULL DEFAULT 1",
  },
  {
    name: "image_max_requests_per_minute",
    definition: "image_max_requests_per_minute INTEGER NOT NULL DEFAULT 2",
  },
  {
    name: "image_max_requests_per_day",
    definition: "image_max_requests_per_day INTEGER NOT NULL DEFAULT 10",
  },
  {
    name: "image_max_concurrent",
    definition: "image_max_concurrent INTEGER NOT NULL DEFAULT 1",
  },
  {
    name: "image_allow_high_quality",
    definition: "image_allow_high_quality INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "image_allowed_sizes",
    definition:
      'image_allowed_sizes TEXT NOT NULL DEFAULT \'["1024x1024","1536x1024","1024x1536"]\'',
  },
] as const;

// Cache for model permission checks
const _modelPermissionCache = new Map<string, { allowed: boolean; timestamp: number }>();

// Prepared statements cache
let _stmtGetAllKeys: ApiKeysStatements["getAllKeys"] | null = null;
let _stmtGetKeyById: ApiKeysStatements["getKeyById"] | null = null;
let _stmtGetKeyCustomerUsageMetadataById:
  | ApiKeysStatements["getKeyCustomerUsageMetadataById"]
  | null = null;
let _stmtValidateKey: ApiKeysStatements["validateKey"] | null = null;
let _stmtGetKeyMetadata: ApiKeysStatements["getKeyMetadata"] | null = null;
let _stmtInsertKey: ApiKeysStatements["insertKey"] | null = null;
let _stmtDeleteKey: ApiKeysStatements["deleteKey"] | null = null;

/**
 * Clear all caches (called on key create/update/delete)
 */
function invalidateCaches() {
  _keyValidationCache.clear();
  _keyMetadataCache.clear();
  _modelPermissionCache.clear();
  _lastUsedUpdateCache.clear();
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function isConfiguredEnvApiKey(key: string): boolean {
  const envKey = process.env.OMNIROUTE_API_KEY || process.env.ROUTER_API_KEY;
  return Boolean(envKey && key === envKey);
}

function isRedisAuthCacheEnabled(): boolean {
  return (
    process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE !== "1" &&
    process.env.NODE_ENV !== "test" &&
    process.env.DISABLE_SQLITE_AUTO_BACKUP !== "true"
  );
}

async function deleteRedisAuthCacheEntry(keyHash: unknown): Promise<void> {
  if (!isRedisAuthCacheEnabled() || typeof keyHash !== "string" || keyHash.trim() === "") return;

  try {
    const { getRedisClient } = await import("@/shared/utils/rateLimiter");
    const redis = getRedisClient();
    if (!redis) return; // #2357: Redis is optional; skip when disabled.
    await redis.del(`auth:api_key:${keyHash}`);
  } catch {
    // Redis is an optimization for auth caching; SQLite remains authoritative.
  }
}

async function deleteRedisAuthCacheEntries(...keyHashes: unknown[]): Promise<void> {
  await Promise.all(keyHashes.map((keyHash) => deleteRedisAuthCacheEntry(keyHash)));
}

async function deleteRedisAuthCacheForKeyId(db: ApiKeysDbLike, id: string): Promise<void> {
  if (!isRedisAuthCacheEnabled()) return;

  const row = db
    .prepare<{ key_hash: string | null }>("SELECT key_hash FROM api_keys WHERE id = ?")
    .get(id);
  await deleteRedisAuthCacheEntry(row?.key_hash);
}

function markApiKeyUsed(db: ApiKeysDbLike, id: unknown, now: number): void {
  if (typeof id !== "string" || id.trim() === "") return;

  const lastUpdate = _lastUsedUpdateCache.get(id);
  if (lastUpdate && now - lastUpdate < LAST_USED_UPDATE_TTL) return;

  db.prepare("UPDATE api_keys SET last_used_at = @lastUsedAt WHERE id = @id").run({
    id,
    lastUsedAt: new Date(now).toISOString(),
  });
  _lastUsedUpdateCache.set(id, now);
}

/**
 * LRU eviction for cache
 */
function evictIfNeeded<TKey, TValue>(cache: Map<TKey, TValue>) {
  if (cache.size > MAX_CACHE_SIZE) {
    // Remove oldest 20% of entries
    const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
    let i = 0;
    for (const key of cache.keys()) {
      if (i++ >= entriesToRemove) break;
      cache.delete(key);
    }
  }
}

/**
 * Match an API-key wildcard scope pattern against a model id without
 * compiling a RegExp from string concatenation (avoid ReDoS exposure on
 * operator-supplied patterns and silence the Semgrep `js/regex-injection`
 * advisory for `new RegExp(<dynamic>)`).
 *
 * Supported pattern syntax (only what real scopes use):
 *   - literal segments
 *   - `*` matches any run of characters, but does NOT cross `/`
 *
 * Walks the pattern token-by-token: each `*` consumes the longest possible
 * run within the current path segment, then the next literal anchor must
 * appear before the segment boundary. Worst-case complexity is O(n*m)
 * where n = pattern length, m = candidate length — there is no nested
 * backtracking that could explode adversarially.
 */
function matchesWildcardPattern(pattern: string, candidate: string): boolean {
  const pSegs = pattern.split("/");
  const cSegs = candidate.split("/");
  if (pSegs.length !== cSegs.length) return false;
  for (let i = 0; i < pSegs.length; i++) {
    if (!segmentMatchesWildcard(pSegs[i], cSegs[i])) return false;
  }
  return true;
}

function segmentMatchesWildcard(pattern: string, segment: string): boolean {
  if (pattern === segment) return true;
  if (!pattern.includes("*")) return false;
  const parts = pattern.split("*");
  // Anchor first literal to the start.
  let cursor = 0;
  const first = parts[0];
  if (first) {
    if (!segment.startsWith(first)) return false;
    cursor = first.length;
  }
  // Anchor last literal to the end.
  const last = parts[parts.length - 1];
  const endLimit = segment.length - last.length;
  if (last) {
    if (!segment.endsWith(last)) return false;
  }
  // Each middle literal must appear in order between cursor and endLimit.
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i];
    if (!piece) continue;
    const idx = segment.indexOf(piece, cursor);
    if (idx === -1 || idx + piece.length > endLimit) return false;
    cursor = idx + piece.length;
  }
  return cursor <= endLimit;
}

function ensureApiKeyColumn(
  db: ApiKeysDbLike,
  columnNames: Set<string>,
  column: (typeof API_KEY_COLUMN_FALLBACKS)[number]
): void {
  if (columnNames.has(column.name)) return;
  db.exec(`ALTER TABLE api_keys ADD COLUMN ${column.definition}`);
  console.log(`[DB] Added api_keys.${column.name} column`);
}

// Ensure api_keys extension columns exist (memoized)
function ensureApiKeysColumns(db: ApiKeysDbLike) {
  if (_schemaChecked) return;

  try {
    const columns = db.prepare<ApiKeyRow>("PRAGMA table_info(api_keys)").all();
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    for (const column of API_KEY_COLUMN_FALLBACKS) {
      ensureApiKeyColumn(db, columnNames, column);
    }
    _schemaChecked = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[DB] Failed to verify api_keys schema:", message);
  }
}

/**
 * Initialize prepared statements (lazy initialization)
 */
function getPreparedStatements(db: ApiKeysDbLike): ApiKeysStatements {
  ensureApiKeysColumns(db);

  if (
    !_stmtGetAllKeys ||
    !_stmtGetKeyById ||
    !_stmtGetKeyCustomerUsageMetadataById ||
    !_stmtValidateKey ||
    !_stmtGetKeyMetadata ||
    !_stmtInsertKey ||
    !_stmtDeleteKey
  ) {
    _stmtGetAllKeys = db.prepare<ApiKeyRow>("SELECT * FROM api_keys ORDER BY created_at");
    _stmtGetKeyById = db.prepare<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ?");
    _stmtGetKeyCustomerUsageMetadataById = db.prepare<ApiKeyRow>(
      "SELECT id, name, key_prefix, is_active, is_banned, expires_at, max_requests_per_day, token_limit, daily_token_limit, hourly_token_limit, token_used FROM api_keys WHERE id = ?"
    );
    _stmtValidateKey = db.prepare<JsonRecord>(
      "SELECT id, expires_at, revoked_at, is_active, is_banned FROM api_keys WHERE key = ? OR key_hash = ?"
    );
    _stmtGetKeyMetadata = db.prepare<ApiKeyRow>(
      "SELECT id, name, machine_id, allowed_models, allowed_connections, no_log, auto_resolve, is_active, access_schedule, max_requests_per_day, max_requests_per_minute, max_sessions, revoked_at, expires_at, ip_allowlist, scopes, rate_limits, is_banned, key_hash, customer_name, internal_note, token_limit, daily_token_limit, hourly_token_limit, token_used, commercial_key, image_generation_enabled, image_max_requests_per_minute, image_max_requests_per_day, image_max_concurrent, image_allow_high_quality, image_allowed_sizes FROM api_keys WHERE key = ? OR key_hash = ?"
    );
    _stmtInsertKey = db.prepare(
      "INSERT INTO api_keys (id, name, key, machine_id, allowed_models, no_log, created_at, key_prefix, key_hash, scopes, customer_name, internal_note, token_limit, daily_token_limit, hourly_token_limit, token_used, commercial_key, max_requests_per_day, max_requests_per_minute, expires_at, image_generation_enabled, image_max_requests_per_minute, image_max_requests_per_day, image_max_concurrent, image_allow_high_quality, image_allowed_sizes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    _stmtDeleteKey = db.prepare("DELETE FROM api_keys WHERE id = ?");
  }

  if (
    !_stmtGetAllKeys ||
    !_stmtGetKeyById ||
    !_stmtGetKeyCustomerUsageMetadataById ||
    !_stmtValidateKey ||
    !_stmtGetKeyMetadata ||
    !_stmtInsertKey ||
    !_stmtDeleteKey
  ) {
    throw new Error("Failed to initialize API key prepared statements");
  }

  return {
    getAllKeys: _stmtGetAllKeys,
    getKeyById: _stmtGetKeyById,
    getKeyCustomerUsageMetadataById: _stmtGetKeyCustomerUsageMetadataById,
    validateKey: _stmtValidateKey,
    getKeyMetadata: _stmtGetKeyMetadata,
    insertKey: _stmtInsertKey,
    deleteKey: _stmtDeleteKey,
  };
}

export async function getApiKeys() {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const rows = stmt.getAllKeys.all();
  return rows.map((row) => {
    const camelRow = toRecord(rowToCamel(row)) as ApiKeyView;
    camelRow.allowedModels = parseAllowedModels(camelRow.allowedModels);
    camelRow.allowedConnections = parseAllowedConnections(camelRow.allowedConnections);
    camelRow.noLog = parseNoLog(camelRow.noLog);
    camelRow.autoResolve = parseAutoResolve(camelRow.autoResolve);
    camelRow.isActive = parseIsActive(camelRow.isActive);
    camelRow.accessSchedule = parseAccessSchedule(camelRow.accessSchedule);
    camelRow.rateLimits = parseRateLimits(camelRow.rateLimits);
    camelRow.isBanned = parseIsBanned(camelRow.isBanned);
    camelRow.customerName = parseNullableString(camelRow.customerName);
    camelRow.internalNote = parseNullableString(camelRow.internalNote);
    camelRow.tokenLimit = parseNullableNonNegativeInt(camelRow.tokenLimit);
    camelRow.dailyTokenLimit = parseNullableNonNegativeInt(camelRow.dailyTokenLimit);
    camelRow.hourlyTokenLimit = parseNullableNonNegativeInt(camelRow.hourlyTokenLimit);
    camelRow.tokenUsed = parseNonNegativeInt(camelRow.tokenUsed);
    camelRow.commercialKey = parseCommercialKey(camelRow.commercialKey);
    camelRow.imageGenerationEnabled = parseBooleanDefault(
      camelRow.imageGenerationEnabled,
      DEFAULT_IMAGE_GENERATION_POLICY.enabled
    );
    camelRow.imageMaxRequestsPerMinute = parseNonNegativeIntWithDefault(
      camelRow.imageMaxRequestsPerMinute,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute
    );
    camelRow.imageMaxRequestsPerDay = parseNonNegativeIntWithDefault(
      camelRow.imageMaxRequestsPerDay,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay
    );
    camelRow.imageMaxConcurrent = parsePositiveIntWithDefault(
      camelRow.imageMaxConcurrent,
      DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent
    );
    camelRow.imageAllowHighQuality = parseBooleanDefault(
      camelRow.imageAllowHighQuality,
      DEFAULT_IMAGE_GENERATION_POLICY.allowHighQuality
    );
    camelRow.imageAllowedSizes = parseImageAllowedSizes(camelRow.imageAllowedSizes);
    if (typeof camelRow.id === "string" && camelRow.id.length > 0) {
      setNoLog(camelRow.id, camelRow.noLog === true);
    }
    return camelRow;
  });
}

export async function getApiKeyById(id: string) {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyById.get(id);
  if (!row) return null;
  const camelRow = toRecord(rowToCamel(row)) as ApiKeyView;
  camelRow.allowedModels = parseAllowedModels(camelRow.allowedModels);
  camelRow.allowedConnections = parseAllowedConnections(camelRow.allowedConnections);
  camelRow.noLog = parseNoLog(camelRow.noLog);
  camelRow.autoResolve = parseAutoResolve(camelRow.autoResolve);
  camelRow.isActive = parseIsActive(camelRow.isActive);
  camelRow.accessSchedule = parseAccessSchedule(camelRow.accessSchedule);
  camelRow.rateLimits = parseRateLimits(camelRow.rateLimits);
  camelRow.isBanned = parseIsBanned(camelRow.isBanned);
  camelRow.customerName = parseNullableString(camelRow.customerName);
  camelRow.internalNote = parseNullableString(camelRow.internalNote);
  camelRow.tokenLimit = parseNullableNonNegativeInt(camelRow.tokenLimit);
  camelRow.dailyTokenLimit = parseNullableNonNegativeInt(camelRow.dailyTokenLimit);
  camelRow.hourlyTokenLimit = parseNullableNonNegativeInt(camelRow.hourlyTokenLimit);
  camelRow.tokenUsed = parseNonNegativeInt(camelRow.tokenUsed);
  camelRow.commercialKey = parseCommercialKey(camelRow.commercialKey);
  camelRow.imageGenerationEnabled = parseBooleanDefault(
    camelRow.imageGenerationEnabled,
    DEFAULT_IMAGE_GENERATION_POLICY.enabled
  );
  camelRow.imageMaxRequestsPerMinute = parseNonNegativeIntWithDefault(
    camelRow.imageMaxRequestsPerMinute,
    DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute
  );
  camelRow.imageMaxRequestsPerDay = parseNonNegativeIntWithDefault(
    camelRow.imageMaxRequestsPerDay,
    DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay
  );
  camelRow.imageMaxConcurrent = parsePositiveIntWithDefault(
    camelRow.imageMaxConcurrent,
    DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent
  );
  camelRow.imageAllowHighQuality = parseBooleanDefault(
    camelRow.imageAllowHighQuality,
    DEFAULT_IMAGE_GENERATION_POLICY.allowHighQuality
  );
  camelRow.imageAllowedSizes = parseImageAllowedSizes(camelRow.imageAllowedSizes);
  if (typeof camelRow.id === "string" && camelRow.id.length > 0) {
    setNoLog(camelRow.id, camelRow.noLog === true);
  }
  return camelRow;
}

export async function getApiKeyCustomerUsageMetadataById(
  id: string
): Promise<ApiKeyCustomerUsageMetadata | null> {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyCustomerUsageMetadataById.get(id);
  if (!row) return null;

  const record = toRecord(row) as ApiKeyRow;
  const metadata: ApiKeyCustomerUsageMetadata = {
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "",
    keyPrefix: parseNullableString(record.key_prefix ?? record.keyPrefix),
    isActive: parseIsActive(record.is_active ?? record.isActive),
    isBanned: parseIsBanned(record.is_banned ?? record.isBanned),
    expiresAt: parseNullableTimestamp(record.expires_at ?? record.expiresAt),
    maxRequestsPerDay: parseNullableNonNegativeInt(
      record.max_requests_per_day ?? record.maxRequestsPerDay
    ),
    tokenLimit: parseNullableNonNegativeInt(record.token_limit ?? record.tokenLimit),
    dailyTokenLimit: parseNullableNonNegativeInt(
      record.daily_token_limit ?? record.dailyTokenLimit
    ),
    hourlyTokenLimit: parseNullableNonNegativeInt(
      record.hourly_token_limit ?? record.hourlyTokenLimit
    ),
    tokenUsed: parseNonNegativeInt(record.token_used ?? record.tokenUsed),
  };

  return metadata.id ? metadata : null;
}

/**
 * Helper function to safely parse allowed_models JSON
 */
function parseAllowedModels(value: unknown): string[] {
  if (!value || typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNoLog(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function parseAutoResolve(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function parseIsActive(value: unknown): boolean {
  // DEFAULT 1 — active unless explicitly set to 0
  if (value === 0 || value === "0" || value === false) return false;
  return true;
}

function parseAccessSchedule(value: unknown): AccessSchedule | null {
  if (!value || typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj["enabled"] !== "boolean" ||
      typeof obj["from"] !== "string" ||
      typeof obj["until"] !== "string" ||
      !Array.isArray(obj["days"]) ||
      typeof obj["tz"] !== "string"
    ) {
      return null;
    }
    const days = (obj["days"] as unknown[]).filter(
      (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6
    );
    return {
      enabled: obj["enabled"],
      from: obj["from"],
      until: obj["until"],
      days,
      tz: obj["tz"],
    };
  } catch {
    return null;
  }
}

function parseRateLimits(value: unknown): RateLimitRule[] | null {
  if (!value || typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (rule: RateLimitRule) =>
        typeof rule === "object" &&
        rule !== null &&
        typeof rule.limit === "number" &&
        typeof rule.window === "number"
    ) as RateLimitRule[];
  } catch {
    return null;
  }
}

/**
 * Helper function to safely parse allowed_connections JSON
 */
function parseAllowedConnections(value: unknown): string[] {
  if (!value || typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStringList(value: unknown): string[] {
  if (!value || typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNullableTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseIsBanned(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNullableNonNegativeInt(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function parseNonNegativeInt(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function parseCommercialKey(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

function parseBooleanDefault(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return fallback;
}

function parseNonNegativeIntWithDefault(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function parsePositiveIntWithDefault(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function parseImageAllowedSizes(value: unknown): string[] {
  const allowed = new Set<string>(IMAGE_GENERATION_ALLOWED_SIZES);
  const parsed = parseStringList(value).filter((size) => allowed.has(size));
  return parsed.length > 0 ? parsed : [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes];
}

async function hashKey(key: string): Promise<string> {
  if (!key || typeof key !== "string") return "";
  // CodeQL: This is intentionally SHA-256, NOT password hashing. API keys are
  // high-entropy random tokens (not user-chosen passwords) and need fast O(1)
  // comparison for per-request validation. bcrypt/scrypt would add ~100ms per
  // request, which is unacceptable for an API proxy.
  // lgtm[js/insufficient-password-hash]
  return createHash("sha256").update(key).digest("hex"); // nosemgrep: insufficient-password-hash
}

function normalizeCreateOptions(
  scopesOrOptions: string[] | CreateApiKeyOptions | undefined
): Required<Pick<CreateApiKeyOptions, "commercialKey">> &
  Omit<CreateApiKeyOptions, "commercialKey"> & { scopes: string[] } {
  if (Array.isArray(scopesOrOptions)) {
    return {
      scopes: scopesOrOptions,
      commercialKey: false,
      customerName: null,
      internalNote: null,
      tokenLimit: null,
      dailyTokenLimit: null,
      hourlyTokenLimit: null,
      maxRequestsPerDay: null,
      maxRequestsPerMinute: null,
      expiresAt: null,
      imageGenerationEnabled: DEFAULT_IMAGE_GENERATION_POLICY.enabled,
      imageMaxRequestsPerMinute: DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute,
      imageMaxRequestsPerDay: DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay,
      imageMaxConcurrent: DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent,
      imageAllowHighQuality: DEFAULT_IMAGE_GENERATION_POLICY.allowHighQuality,
      imageAllowedSizes: [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes],
    };
  }

  return {
    scopes: Array.isArray(scopesOrOptions?.scopes) ? scopesOrOptions.scopes : [],
    customerName: scopesOrOptions?.customerName ?? null,
    internalNote: scopesOrOptions?.internalNote ?? null,
    tokenLimit: scopesOrOptions?.tokenLimit ?? null,
    dailyTokenLimit: scopesOrOptions?.dailyTokenLimit ?? null,
    hourlyTokenLimit: scopesOrOptions?.hourlyTokenLimit ?? null,
    maxRequestsPerDay: scopesOrOptions?.maxRequestsPerDay ?? null,
    maxRequestsPerMinute: scopesOrOptions?.maxRequestsPerMinute ?? null,
    expiresAt: scopesOrOptions?.expiresAt ?? null,
    commercialKey: scopesOrOptions?.commercialKey === true,
    imageGenerationEnabled:
      scopesOrOptions?.imageGenerationEnabled ?? DEFAULT_IMAGE_GENERATION_POLICY.enabled,
    imageMaxRequestsPerMinute:
      scopesOrOptions?.imageMaxRequestsPerMinute ??
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute,
    imageMaxRequestsPerDay:
      scopesOrOptions?.imageMaxRequestsPerDay ?? DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay,
    imageMaxConcurrent:
      scopesOrOptions?.imageMaxConcurrent ?? DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent,
    imageAllowHighQuality:
      scopesOrOptions?.imageAllowHighQuality ?? DEFAULT_IMAGE_GENERATION_POLICY.allowHighQuality,
    imageAllowedSizes: Array.isArray(scopesOrOptions?.imageAllowedSizes)
      ? scopesOrOptions.imageAllowedSizes
      : [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes],
  };
}

export async function createApiKey(
  name: string,
  machineId: string,
  scopesOrOptions: string[] | CreateApiKeyOptions = []
) {
  if (!machineId) {
    throw new Error("machineId is required");
  }

  const options = normalizeCreateOptions(scopesOrOptions);
  const db = getDbInstance() as ApiKeysDbLike;
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine, generateQrouterApiKey } =
    await import("@/shared/utils/apiKey");
  const result = options.commercialKey
    ? generateQrouterApiKey()
    : generateApiKeyWithMachine(machineId);
  const tokenLimit = parseNullableNonNegativeInt(options.tokenLimit);
  const dailyTokenLimit = parseNullableNonNegativeInt(options.dailyTokenLimit);
  const hourlyTokenLimit = parseNullableNonNegativeInt(options.hourlyTokenLimit);
  const maxRequestsPerDay = parseNullableNonNegativeInt(options.maxRequestsPerDay);
  const maxRequestsPerMinute = parseNullableNonNegativeInt(options.maxRequestsPerMinute);

  const apiKey = {
    id: uuidv4(),
    name: name,
    key: result.key,
    machineId: machineId,
    allowedModels: [], // Empty array means all models allowed
    allowedConnections: [], // Empty array means all connections allowed
    noLog: false,
    createdAt: now,
    scopes: options.scopes,
    customerName: parseNullableString(options.customerName),
    internalNote: parseNullableString(options.internalNote),
    tokenLimit,
    dailyTokenLimit,
    hourlyTokenLimit,
    tokenUsed: 0,
    commercialKey: options.commercialKey,
    maxRequestsPerDay,
    maxRequestsPerMinute,
    expiresAt: parseNullableTimestamp(options.expiresAt),
    imageGenerationEnabled: options.imageGenerationEnabled !== false,
    imageMaxRequestsPerMinute: parseNonNegativeIntWithDefault(
      options.imageMaxRequestsPerMinute,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute
    ),
    imageMaxRequestsPerDay: parseNonNegativeIntWithDefault(
      options.imageMaxRequestsPerDay,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay
    ),
    imageMaxConcurrent: parsePositiveIntWithDefault(
      options.imageMaxConcurrent,
      DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent
    ),
    imageAllowHighQuality: options.imageAllowHighQuality === true,
    imageAllowedSizes: parseImageAllowedSizes(options.imageAllowedSizes),
  };

  const stmt = getPreparedStatements(db);
  stmt.insertKey.run(
    apiKey.id,
    apiKey.name,
    apiKey.key,
    apiKey.machineId,
    "[]",
    0,
    apiKey.createdAt,
    apiKey.key.slice(0, 24),
    await hashKey(apiKey.key),
    JSON.stringify(options.scopes),
    apiKey.customerName,
    apiKey.internalNote,
    apiKey.tokenLimit,
    apiKey.dailyTokenLimit,
    apiKey.hourlyTokenLimit,
    apiKey.tokenUsed,
    apiKey.commercialKey ? 1 : 0,
    apiKey.maxRequestsPerDay,
    apiKey.maxRequestsPerMinute,
    apiKey.expiresAt,
    apiKey.imageGenerationEnabled ? 1 : 0,
    apiKey.imageMaxRequestsPerMinute,
    apiKey.imageMaxRequestsPerDay,
    apiKey.imageMaxConcurrent,
    apiKey.imageAllowHighQuality ? 1 : 0,
    JSON.stringify(
      apiKey.imageAllowedSizes.length > 0
        ? apiKey.imageAllowedSizes
        : DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes
    )
  );
  setNoLog(apiKey.id, false);

  backupDbFile("pre-write");
  return apiKey;
}

export async function regenerateApiKey(id: string) {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyById.get(id) as ApiKeyRow | undefined;
  if (!row) return null;

  const { generateApiKeyWithMachine, generateQrouterApiKey } =
    await import("@/shared/utils/apiKey");
  const machineId = (row.machine_id || row.machineId || "0000000000000000") as string;
  const isCommercial = parseCommercialKey(row.commercial_key ?? (row as JsonRecord).commercialKey);
  const { key: newKey } = isCommercial
    ? generateQrouterApiKey()
    : generateApiKeyWithMachine(machineId);
  const newHash = await hashKey(newKey);
  const newPrefix = newKey.slice(0, 12);

  // Update in DB
  const updateStmt = db.prepare(
    "UPDATE api_keys SET key = ?, key_hash = ?, key_prefix = ? WHERE id = ?"
  );
  updateStmt.run(newKey, newHash, newPrefix, id);

  // Invalidate all caches
  clearApiKeyCaches();

  await deleteRedisAuthCacheEntries(row.key_hash, newHash);

  const { logAuditEvent } = await import("@/lib/compliance");
  logAuditEvent({
    action: "apiKey.regenerate",
    target: id,
    details: { name: String(row.name || "") },
  });

  return { id, key: newKey };
}

export async function updateApiKeyPermissions(
  id: string,
  update:
    | string[]
    | {
        name?: string;
        allowedModels?: string[];
        allowedConnections?: string[];
        noLog?: boolean;
        autoResolve?: boolean;
        isActive?: boolean;
        accessSchedule?: AccessSchedule | null;
        maxRequestsPerDay?: number | null;
        maxRequestsPerMinute?: number | null;
        rateLimits?: RateLimitRule[] | null;
        isBanned?: boolean;
        expiresAt?: string | null;
        customerName?: string | null;
        internalNote?: string | null;
        tokenLimit?: number | null;
        dailyTokenLimit?: number | null;
        hourlyTokenLimit?: number | null;
        // T08: max concurrent sessions for this key (0 = unlimited)
        maxSessions?: number | null;
        scopes?: string[] | null;
        imageGenerationEnabled?: boolean;
        imageMaxRequestsPerMinute?: number;
        imageMaxRequestsPerDay?: number;
        imageMaxConcurrent?: number;
        imageAllowHighQuality?: boolean;
        imageAllowedSizes?: string[];
      }
) {
  const db = getDbInstance() as ApiKeysDbLike;
  getPreparedStatements(db);

  const normalized =
    Array.isArray(update) || update === undefined
      ? { allowedModels: update || [] }
      : {
          name: update.name,
          allowedModels: update.allowedModels,
          allowedConnections: update.allowedConnections,
          noLog: update.noLog,
          autoResolve: update.autoResolve,
          isActive: update.isActive,
          accessSchedule: update.accessSchedule,
          maxRequestsPerDay: update.maxRequestsPerDay,
          maxRequestsPerMinute: update.maxRequestsPerMinute,
          rateLimits: update.rateLimits,
          isBanned: update.isBanned,
          expiresAt: update.expiresAt,
          customerName: update.customerName,
          internalNote: update.internalNote,
          tokenLimit: update.tokenLimit,
          dailyTokenLimit: update.dailyTokenLimit,
          hourlyTokenLimit: update.hourlyTokenLimit,
          maxSessions: (update as { maxSessions?: number | null }).maxSessions,
          scopes: (update as { scopes?: string[] | null }).scopes,
          imageGenerationEnabled: update.imageGenerationEnabled,
          imageMaxRequestsPerMinute: update.imageMaxRequestsPerMinute,
          imageMaxRequestsPerDay: update.imageMaxRequestsPerDay,
          imageMaxConcurrent: update.imageMaxConcurrent,
          imageAllowHighQuality: update.imageAllowHighQuality,
          imageAllowedSizes: update.imageAllowedSizes,
        };

  if (
    normalized.name === undefined &&
    normalized.allowedModels === undefined &&
    normalized.allowedConnections === undefined &&
    normalized.noLog === undefined &&
    normalized.autoResolve === undefined &&
    normalized.isActive === undefined &&
    normalized.accessSchedule === undefined &&
    normalized.maxRequestsPerDay === undefined &&
    normalized.maxRequestsPerMinute === undefined &&
    normalized.rateLimits === undefined &&
    normalized.isBanned === undefined &&
    normalized.expiresAt === undefined &&
    normalized.customerName === undefined &&
    normalized.internalNote === undefined &&
    normalized.tokenLimit === undefined &&
    normalized.dailyTokenLimit === undefined &&
    normalized.hourlyTokenLimit === undefined &&
    (normalized as Record<string, unknown>).maxSessions === undefined &&
    (normalized as Record<string, unknown>).scopes === undefined &&
    normalized.imageGenerationEnabled === undefined &&
    normalized.imageMaxRequestsPerMinute === undefined &&
    normalized.imageMaxRequestsPerDay === undefined &&
    normalized.imageMaxConcurrent === undefined &&
    normalized.imageAllowHighQuality === undefined &&
    normalized.imageAllowedSizes === undefined
  ) {
    return false;
  }

  const updates: string[] = [];
  const params: {
    id: string;
    name?: string;
    allowedModels?: string;
    allowedConnections?: string;
    noLog?: number;
    autoResolve?: number;
    isActive?: number;
    accessSchedule?: string | null;
    maxRequestsPerDay?: number | null;
    maxRequestsPerMinute?: number | null;
    rateLimits?: string | null;
    isBanned?: number;
    maxSessions?: number;
    expiresAt?: string | null;
    customerName?: string | null;
    internalNote?: string | null;
    tokenLimit?: number | null;
    dailyTokenLimit?: number | null;
    hourlyTokenLimit?: number | null;
    scopes?: string;
    imageGenerationEnabled?: number;
    imageMaxRequestsPerMinute?: number;
    imageMaxRequestsPerDay?: number;
    imageMaxConcurrent?: number;
    imageAllowHighQuality?: number;
    imageAllowedSizes?: string;
  } = { id };

  if (normalized.name !== undefined) {
    updates.push("name = @name");
    params.name = normalized.name;
  }

  if (normalized.allowedModels !== undefined) {
    // Empty array means all models are allowed
    updates.push("allowed_models = @allowedModels");
    params.allowedModels = JSON.stringify(normalized.allowedModels || []);
  }

  if (normalized.allowedConnections !== undefined) {
    // Empty array means all connections are allowed
    updates.push("allowed_connections = @allowedConnections");
    params.allowedConnections = JSON.stringify(normalized.allowedConnections || []);
  }

  if (normalized.noLog !== undefined) {
    updates.push("no_log = @noLog");
    params.noLog = normalized.noLog ? 1 : 0;
  }

  if (normalized.autoResolve !== undefined) {
    updates.push("auto_resolve = @autoResolve");
    params.autoResolve = normalized.autoResolve ? 1 : 0;
  }

  if (normalized.isActive !== undefined) {
    updates.push("is_active = @isActive");
    params.isActive = normalized.isActive ? 1 : 0;
  }

  if (normalized.accessSchedule !== undefined) {
    updates.push("access_schedule = @accessSchedule");
    params.accessSchedule =
      normalized.accessSchedule !== null ? JSON.stringify(normalized.accessSchedule) : null;
  }

  if (normalized.maxRequestsPerDay !== undefined) {
    updates.push("max_requests_per_day = @maxRequestsPerDay");
    params.maxRequestsPerDay = normalized.maxRequestsPerDay;
  }

  if (normalized.maxRequestsPerMinute !== undefined) {
    updates.push("max_requests_per_minute = @maxRequestsPerMinute");
    params.maxRequestsPerMinute = normalized.maxRequestsPerMinute;
  }

  if (normalized.rateLimits !== undefined) {
    updates.push("rate_limits = @rateLimits");
    params.rateLimits =
      normalized.rateLimits !== null ? JSON.stringify(normalized.rateLimits) : null;
  }

  if (normalized.isBanned !== undefined) {
    updates.push("is_banned = @isBanned");
    params.isBanned = normalized.isBanned ? 1 : 0;
  }

  if (normalized.expiresAt !== undefined) {
    updates.push("expires_at = @expiresAt");
    params.expiresAt = normalized.expiresAt;
  }

  if (normalized.customerName !== undefined) {
    updates.push("customer_name = @customerName");
    params.customerName = parseNullableString(normalized.customerName);
  }

  if (normalized.internalNote !== undefined) {
    updates.push("internal_note = @internalNote");
    params.internalNote = parseNullableString(normalized.internalNote);
  }

  if (normalized.tokenLimit !== undefined) {
    updates.push("token_limit = @tokenLimit");
    params.tokenLimit = parseNullableNonNegativeInt(normalized.tokenLimit);
  }

  if (normalized.dailyTokenLimit !== undefined) {
    updates.push("daily_token_limit = @dailyTokenLimit");
    params.dailyTokenLimit = parseNullableNonNegativeInt(normalized.dailyTokenLimit);
  }

  if (normalized.hourlyTokenLimit !== undefined) {
    updates.push("hourly_token_limit = @hourlyTokenLimit");
    params.hourlyTokenLimit = parseNullableNonNegativeInt(normalized.hourlyTokenLimit);
  }

  const maxSessionsUpdate = (normalized as Record<string, unknown>).maxSessions;
  if (maxSessionsUpdate !== undefined) {
    updates.push("max_sessions = @maxSessions");
    params.maxSessions = typeof maxSessionsUpdate === "number" ? Math.max(0, maxSessionsUpdate) : 0;
  }

  const scopesUpdate = (normalized as Record<string, unknown>).scopes;
  if (scopesUpdate !== undefined) {
    updates.push("scopes = @scopes");
    params.scopes = JSON.stringify(Array.isArray(scopesUpdate) ? scopesUpdate : []);
  }

  if (normalized.imageGenerationEnabled !== undefined) {
    updates.push("image_generation_enabled = @imageGenerationEnabled");
    params.imageGenerationEnabled = normalized.imageGenerationEnabled ? 1 : 0;
  }

  if (normalized.imageMaxRequestsPerMinute !== undefined) {
    updates.push("image_max_requests_per_minute = @imageMaxRequestsPerMinute");
    params.imageMaxRequestsPerMinute = Math.max(0, normalized.imageMaxRequestsPerMinute);
  }

  if (normalized.imageMaxRequestsPerDay !== undefined) {
    updates.push("image_max_requests_per_day = @imageMaxRequestsPerDay");
    params.imageMaxRequestsPerDay = Math.max(0, normalized.imageMaxRequestsPerDay);
  }

  if (normalized.imageMaxConcurrent !== undefined) {
    updates.push("image_max_concurrent = @imageMaxConcurrent");
    params.imageMaxConcurrent = Math.max(1, normalized.imageMaxConcurrent);
  }

  if (normalized.imageAllowHighQuality !== undefined) {
    updates.push("image_allow_high_quality = @imageAllowHighQuality");
    params.imageAllowHighQuality = normalized.imageAllowHighQuality ? 1 : 0;
  }

  if (normalized.imageAllowedSizes !== undefined) {
    updates.push("image_allowed_sizes = @imageAllowedSizes");
    params.imageAllowedSizes = JSON.stringify(normalized.imageAllowedSizes);
  }

  const result = db.prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = @id`).run(params);

  if (result.changes === 0) return false;

  const { logAuditEvent } = await import("@/lib/compliance");

  if (normalized.isBanned !== undefined) {
    logAuditEvent({
      action: normalized.isBanned ? "apiKey.ban" : "apiKey.unban",
      target: id,
    });
  }

  if (normalized.isActive !== undefined) {
    logAuditEvent({
      action: normalized.isActive ? "apiKey.activate" : "apiKey.deactivate",
      target: id,
    });
  }

  if (normalized.noLog !== undefined) {
    setNoLog(id, normalized.noLog);
  }

  // Invalidate caches since permissions changed
  invalidateCaches();

  await deleteRedisAuthCacheForKeyId(db, id);

  backupDbFile("pre-write");
  return true;
}

export async function deleteApiKey(id: string) {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyById.get(id) as ApiKeyRow | undefined;
  const result = stmt.deleteKey.run(id);

  if (result.changes === 0) return false;

  db.prepare("DELETE FROM domain_budgets WHERE api_key_id = ?").run(id);
  db.prepare("DELETE FROM domain_cost_history WHERE api_key_id = ?").run(id);
  setNoLog(id, false);

  // Invalidate caches since a key was removed
  invalidateCaches();
  await deleteRedisAuthCacheEntry(row?.key_hash);

  backupDbFile("pre-write");
  return true;
}

/**
 * Revoke an API key by id. Logical, not destructive: the row stays so it can
 * be audited, but validateApiKey() rejects it immediately after caches expire
 * (or sooner because invalidateCaches() runs here).
 */
export async function revokeApiKey(id: string): Promise<boolean> {
  const db = getDbInstance() as ApiKeysDbLike;
  getPreparedStatements(db);

  const result = db
    .prepare(
      "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, @ts), is_active = 0 WHERE id = @id"
    )
    .run({ id, ts: new Date().toISOString() });

  if ((result.changes ?? 0) === 0) return false;

  invalidateCaches();
  await deleteRedisAuthCacheForKeyId(db, id);
  backupDbFile("pre-write");
  return true;
}

/**
 * Set or clear the expiry of an API key. Pass null to remove the expiry.
 */
export async function setApiKeyExpiry(id: string, expiresAt: string | null): Promise<boolean> {
  const db = getDbInstance() as ApiKeysDbLike;
  getPreparedStatements(db);

  const result = db
    .prepare("UPDATE api_keys SET expires_at = @expiresAt WHERE id = @id")
    .run({ id, expiresAt });

  if ((result.changes ?? 0) === 0) return false;

  invalidateCaches();
  await deleteRedisAuthCacheForKeyId(db, id);
  backupDbFile("pre-write");
  return true;
}

export function incrementApiKeyTokenUsage(id: string, totalTokens: number): boolean {
  if (!id || !Number.isFinite(totalTokens) || totalTokens <= 0) return false;

  const db = getDbInstance() as ApiKeysDbLike;
  getPreparedStatements(db);
  const result = db
    .prepare("UPDATE api_keys SET token_used = COALESCE(token_used, 0) + @tokens WHERE id = @id")
    .run({ id, tokens: Math.floor(totalTokens) });

  if ((result.changes ?? 0) > 0) {
    invalidateCaches();
    return true;
  }

  return false;
}

/**
 * Validate API key with lifecycle gates and caching.
 *
 * A key is valid only when ALL of the following are true:
 *   - the row exists,
 *   - is_active = 1,
 *   - revoked_at IS NULL,
 *   - expires_at IS NULL OR expires_at > now.
 *
 * Cache TTL is short (CACHE_TTL) and the metadata cache is also invalidated
 * by revokeApiKey/updateApiKeyPermissions/deleteApiKey, so a revoke takes
 * effect within at most CACHE_TTL even without an explicit clear in the
 * caller.
 */
export async function validateApiKey(key: string | null | undefined) {
  if (!key || typeof key !== "string") return false;

  if (isConfiguredEnvApiKey(key)) return true;

  const now = Date.now();
  const hashedKey = await hashKey(key);
  const cacheKey = hashedKey;

  const cached = _keyValidationCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.valid;
  }

  if (isRedisAuthCacheEnabled()) {
    // Try Redis cache for multi-instance consistency
    try {
      const { getRedisClient } = await import("@/shared/utils/rateLimiter");
      const redis = getRedisClient();
      if (!redis) throw new Error("redis-disabled"); // #2357: optional
      const redisKey = `auth:api_key:${hashedKey}`;
      const redisData = await redis.get(redisKey);
      if (redisData) {
        const data = JSON.parse(redisData);
        const isBanned = !!data.isBanned;
        const isActive = !!data.isActive;
        const revokedAt = data.revokedAt;
        const expiresAt = data.expiresAt;

        if (isBanned || !isActive) return false;
        if (typeof revokedAt === "string" && revokedAt.trim() !== "") return false;
        if (typeof expiresAt === "string" && expiresAt.trim() !== "") {
          const expiresMs = Date.parse(expiresAt);
          if (Number.isFinite(expiresMs) && expiresMs <= now) return false;
        }
        return true;
      }
    } catch {
      // Redis lookup failures fall through to SQLite.
    }
  }

  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.validateKey.get(key, hashedKey) as JsonRecord | undefined;

  if (!row) return false;

  const isBanned = parseIsBanned(row.is_banned ?? row.isBanned);
  if (isBanned) return false;

  const isActive = parseIsActive(row.is_active ?? row.isActive);
  if (!isActive) return false;

  const revokedAt = row.revoked_at ?? row.revokedAt;
  if (typeof revokedAt === "string" && revokedAt.trim() !== "") return false;

  const expiresAt = row.expires_at ?? row.expiresAt;
  if (typeof expiresAt === "string" && expiresAt.trim() !== "") {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now) return false;
  }

  evictIfNeeded(_keyValidationCache);
  _keyValidationCache.set(cacheKey, { valid: true, timestamp: now });

  if (isRedisAuthCacheEnabled()) {
    // Update Redis cache for fast validation
    try {
      const { getRedisClient } = await import("@/shared/utils/rateLimiter");
      const redis = getRedisClient();
      // #2357: Redis is optional; throw so the catch below skips the write
      // without affecting the function's `Promise<boolean>` return type.
      if (!redis) throw new Error("redis-disabled");
      const redisKey = `auth:api_key:${hashedKey}`;
      await redis.set(
        redisKey,
        JSON.stringify({
          id: row.id,
          isBanned: parseIsBanned(row.is_banned),
          isActive: parseIsActive(row.is_active),
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }),
        "EX",
        3600 // 1 hour cache
      );
    } catch {
      // Redis cache update failures do not block successful SQLite validation.
    }
  }

  markApiKeyUsed(db, row.id, now);

  return true;
}

/**
 * Get API key metadata with caching for performance
 */
export async function getApiKeyMetadata(
  key: string | null | undefined
): Promise<ApiKeyMetadata | null> {
  if (!key || typeof key !== "string") return null;

  const now = Date.now();

  // persistent env-var key support (persistent passthrough keys) (#1350)
  if (isConfiguredEnvApiKey(key)) {
    return {
      id: "env-key",
      name: "Environment Key",
      machineId: "server-env",
      allowedModels: [],
      allowedConnections: [],
      noLog: false,
      autoResolve: true,
      isActive: true,
      accessSchedule: null,
      rateLimits: null,
      maxRequestsPerDay: null,
      maxRequestsPerMinute: null,
      maxSessions: 0,
      revokedAt: null,
      expiresAt: null,
      ipAllowlist: [],
      isBanned: false,
      keyHash: null,
      customerName: null,
      internalNote: null,
      tokenLimit: null,
      dailyTokenLimit: null,
      hourlyTokenLimit: null,
      tokenUsed: 0,
      commercialKey: false,
      imageGenerationEnabled: false,
      imageMaxRequestsPerMinute: 0,
      imageMaxRequestsPerDay: 0,
      imageMaxConcurrent: 1,
      imageAllowHighQuality: false,
      imageAllowedSizes: [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes],
      scopes: ["manage"],
    };
  }

  // Check cache first
  const hashedKey = await hashKey(key);
  const cached = _keyMetadataCache.get(hashedKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyMetadata.get(key, hashedKey);

  if (!row) return null;

  const record = toRecord(row) as ApiKeyRow;
  const metadataId = typeof record.id === "string" ? record.id : "";
  const metadataName = typeof record.name === "string" ? record.name : "";
  const machineIdRaw = record.machine_id ?? record.machineId;
  const metadataMachineId = typeof machineIdRaw === "string" ? machineIdRaw : null;

  const rawMaxRPD = record.max_requests_per_day ?? record.maxRequestsPerDay;
  const rawMaxRPM = record.max_requests_per_minute ?? record.maxRequestsPerMinute;

  const rawMaxSessions = record.max_sessions ?? record.maxSessions;

  const metadata: ApiKeyMetadata = {
    id: metadataId,
    name: metadataName,
    machineId: metadataMachineId,
    allowedModels: parseAllowedModels(record.allowed_models ?? record.allowedModels),
    allowedConnections: parseAllowedConnections(
      record.allowed_connections ?? record.allowedConnections
    ),
    noLog: parseNoLog(record.no_log ?? record.noLog),
    autoResolve: parseAutoResolve(record.auto_resolve ?? record.autoResolve),
    isActive: parseIsActive(record.is_active ?? record.isActive),
    accessSchedule: parseAccessSchedule(record.access_schedule ?? record.accessSchedule),
    rateLimits: parseRateLimits(record.rate_limits ?? (record as JsonRecord).rateLimits),
    maxRequestsPerDay: typeof rawMaxRPD === "number" && rawMaxRPD > 0 ? rawMaxRPD : null,
    maxRequestsPerMinute: typeof rawMaxRPM === "number" && rawMaxRPM > 0 ? rawMaxRPM : null,
    // T08: max concurrent sessions; 0 = unlimited (default & backward-compatible)
    maxSessions: typeof rawMaxSessions === "number" && rawMaxSessions > 0 ? rawMaxSessions : 0,
    revokedAt: parseNullableTimestamp(record.revoked_at ?? (record as JsonRecord).revokedAt),
    expiresAt: parseNullableTimestamp(record.expires_at ?? (record as JsonRecord).expiresAt),
    ipAllowlist: parseStringList(record.ip_allowlist ?? (record as JsonRecord).ipAllowlist),
    scopes: parseStringList((record as JsonRecord).scopes),
    isBanned: parseIsBanned(record.is_banned ?? (record as JsonRecord).isBanned),
    keyHash: (record.key_hash ?? (record as JsonRecord).keyHash) as string | null,
    customerName: parseNullableString(record.customer_name ?? (record as JsonRecord).customerName),
    internalNote: parseNullableString(record.internal_note ?? (record as JsonRecord).internalNote),
    tokenLimit: parseNullableNonNegativeInt(
      record.token_limit ?? (record as JsonRecord).tokenLimit
    ),
    dailyTokenLimit: parseNullableNonNegativeInt(
      record.daily_token_limit ?? (record as JsonRecord).dailyTokenLimit
    ),
    hourlyTokenLimit: parseNullableNonNegativeInt(
      record.hourly_token_limit ?? (record as JsonRecord).hourlyTokenLimit
    ),
    tokenUsed: parseNonNegativeInt(record.token_used ?? (record as JsonRecord).tokenUsed),
    commercialKey: parseCommercialKey(
      record.commercial_key ?? (record as JsonRecord).commercialKey
    ),
    imageGenerationEnabled: parseBooleanDefault(
      record.image_generation_enabled ?? (record as JsonRecord).imageGenerationEnabled,
      DEFAULT_IMAGE_GENERATION_POLICY.enabled
    ),
    imageMaxRequestsPerMinute: parseNonNegativeIntWithDefault(
      record.image_max_requests_per_minute ?? (record as JsonRecord).imageMaxRequestsPerMinute,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute
    ),
    imageMaxRequestsPerDay: parseNonNegativeIntWithDefault(
      record.image_max_requests_per_day ?? (record as JsonRecord).imageMaxRequestsPerDay,
      DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay
    ),
    imageMaxConcurrent: parsePositiveIntWithDefault(
      record.image_max_concurrent ?? (record as JsonRecord).imageMaxConcurrent,
      DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent
    ),
    imageAllowHighQuality: parseBooleanDefault(
      record.image_allow_high_quality ?? (record as JsonRecord).imageAllowHighQuality,
      DEFAULT_IMAGE_GENERATION_POLICY.allowHighQuality
    ),
    imageAllowedSizes: parseImageAllowedSizes(
      record.image_allowed_sizes ?? (record as JsonRecord).imageAllowedSizes
    ),
  };

  if (!metadata.id) {
    return null;
  }

  setNoLog(metadata.id, metadata.noLog === true);

  // Cache the result
  evictIfNeeded(_keyMetadataCache);
  _keyMetadataCache.set(hashedKey, { value: metadata, timestamp: now });

  return metadata;
}

/**
 * Check if a model is allowed for a given API key
 * @param {string} key - The API key
 * @param {string} modelId - The model ID to check
 * @returns {boolean} - true if allowed, false if not
 */
export async function isModelAllowedForKey(
  key: string | null | undefined,
  modelId: string | null | undefined
) {
  // If no key provided, allow (request may be using different auth method like JWT)
  // If no modelId provided, deny (invalid request)
  if (!key) return true;
  if (!modelId) return false;

  // Create cache key
  const cacheKey = `${key}:${modelId}`;
  const now = Date.now();

  // Check permission cache
  const cached = _modelPermissionCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.allowed;
  }

  const metadata = await getApiKeyMetadata(key);
  // SECURITY: Key not found in database = deny access (invalid/non-existent key)
  if (!metadata) return false;

  const { allowedModels } = metadata;

  // Empty array means all models allowed
  if (!allowedModels || allowedModels.length === 0) {
    return true;
  }

  let allowed = false;

  // Check if model matches each allowed pattern
  // Support exact match and prefix match (e.g., "openai/*" allows all OpenAI models)
  for (const pattern of allowedModels) {
    if (pattern === modelId) {
      allowed = true;
      break;
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2); // Remove "/*"
      if (modelId.startsWith(prefix + "/") || modelId.startsWith(prefix)) {
        allowed = true;
        break;
      }
    }
    // Support wildcard patterns via deterministic matcher (no RegExp
    // compilation from operator input — avoids ReDoS exposure).
    if (pattern.includes("*")) {
      if (matchesWildcardPattern(pattern, modelId)) {
        allowed = true;
        break;
      }
    }
  }

  // Cache the result
  evictIfNeeded(_modelPermissionCache);
  _modelPermissionCache.set(cacheKey, { allowed, timestamp: now });

  return allowed;
}

/**
 * Clear prepared statements cache (called on database reset/restore)
 * Prepared statements are bound to a specific database connection,
 * so they must be cleared when the connection is reset.
 */
function clearPreparedStatementCache() {
  _stmtGetAllKeys = null;
  _stmtGetKeyById = null;
  _stmtGetKeyCustomerUsageMetadataById = null;
  _stmtValidateKey = null;
  _stmtGetKeyMetadata = null;
  _stmtInsertKey = null;
  _stmtDeleteKey = null;
  _schemaChecked = false; // Also reset schema check for new connection
}

/**
 * Clear all caches (exported for testing/debugging)
 */
export function clearApiKeyCaches() {
  invalidateCaches();
  _lastUsedUpdateCache.clear();
  _modelPermissionCache.clear();
}

/**
 * Reset all cached state for database connection reset/restore.
 * Called by backup.ts when the database is restored.
 */
export function resetApiKeyState() {
  clearPreparedStatementCache();
  clearApiKeyCaches();
}

registerDbStateResetter(resetApiKeyState);
