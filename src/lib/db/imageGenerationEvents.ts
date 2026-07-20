import { createHash, randomUUID } from "crypto";
import { getDbInstance } from "./core";
import {
  DEFAULT_IMAGE_GENERATION_POLICY,
  DEFAULT_IMAGE_GLOBAL_CONCURRENCY,
  IMAGE_GENERATION_ALLOWED_SIZES,
} from "@/shared/constants/imageGeneration";

const RUNNING_EVENT_TTL_MS = 180_000;
const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_MS = 90 * DAY_WINDOW_MS;

export type ImageGenerationOperation = "generation" | "edit";
export type ImageGenerationStatus = "running" | "succeeded" | "failed" | "rejected" | "expired";
export type ImageGenerationRejectionReason =
  | "api_key_missing"
  | "image_generation_disabled"
  | "image_high_quality_not_allowed"
  | "image_size_not_allowed"
  | "image_rate_limit_minute"
  | "image_rate_limit_day"
  | "image_concurrency_key"
  | "image_concurrency_global";

type DbRow = Record<string, unknown>;

interface ImagePolicyRow extends DbRow {
  id: string;
  name: string;
  image_generation_enabled: number;
  image_max_requests_per_minute: number;
  image_max_requests_per_day: number;
  image_max_concurrent: number;
  image_allow_high_quality: number;
  image_allowed_sizes: string;
}

export interface BeginImageGenerationEventInput {
  apiKeyId: string;
  apiKeyName?: string;
  requestId: string;
  operation: ImageGenerationOperation;
  provider?: string | null;
  model: string;
  requestedCount: number;
  size?: string | null;
  quality?: string | null;
  outputFormat?: string | null;
  prompt?: string | null;
  now?: Date;
}

export type BeginImageGenerationEventResult =
  | { allowed: true; eventId: string; requestId: string }
  | {
      allowed: false;
      eventId: string | null;
      requestId: string;
      reason: ImageGenerationRejectionReason;
    };

export interface CompleteImageGenerationEventInput {
  eventId: string;
  status: "succeeded" | "failed";
  httpStatus: number;
  generatedCount: number;
  connectionId?: string | null;
  upstreamRequestId?: string | null;
  errorCode?: string | null;
  durationMs: number;
  now?: Date;
}

export interface ImageGenerationEvent {
  id: string;
  requestId: string;
  apiKeyId: string | null;
  apiKeyName: string;
  operation: ImageGenerationOperation;
  provider: string | null;
  model: string;
  connectionId: string | null;
  requestedCount: number;
  generatedCount: number;
  size: string | null;
  quality: string | null;
  outputFormat: string | null;
  promptSha256: string | null;
  promptLength: number;
  status: ImageGenerationStatus;
  httpStatus: number | null;
  errorCode: string | null;
  upstreamRequestId: string | null;
  durationMs: number;
  createdAt: string;
  completedAt: string | null;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseAllowedSizes(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes];
  }
  try {
    const allowedSet = new Set<string>(IMAGE_GENERATION_ALLOWED_SIZES);
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes];
    const filtered = parsed.filter(
      (size): size is string => typeof size === "string" && allowedSet.has(size)
    );
    return filtered.length > 0 ? filtered : [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes];
  } catch {
    return [...DEFAULT_IMAGE_GENERATION_POLICY.allowedSizes];
  }
}

function getGlobalConcurrencyLimit(): number {
  return positiveInt(
    process.env.IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT,
    DEFAULT_IMAGE_GLOBAL_CONCURRENCY
  );
}

function promptFingerprint(prompt: string | null | undefined): {
  promptSha256: string | null;
  promptLength: number;
} {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { promptSha256: null, promptLength: 0 };
  }
  return {
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    promptLength: prompt.length,
  };
}

function expireStaleRunningEvents(now: Date): void {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - RUNNING_EVENT_TTL_MS).toISOString();
  getDbInstance()
    .prepare(
      `
      UPDATE image_generation_events
      SET status = 'expired',
          http_status = 504,
          error_code = 'image_request_lease_expired',
          duration_ms = MAX(0, CAST((julianday(@now) - julianday(created_at)) * 86400000 AS INTEGER)),
          completed_at = @now
      WHERE status = 'running' AND created_at <= @cutoff
    `
    )
    .run({ now: nowIso, cutoff: cutoffIso });
}

function insertRejectedEvent(
  input: BeginImageGenerationEventInput,
  policy: ImagePolicyRow,
  reason: ImageGenerationRejectionReason,
  now: Date
): string {
  const eventId = randomUUID();
  const prompt = promptFingerprint(input.prompt);
  getDbInstance()
    .prepare(
      `
      INSERT INTO image_generation_events
        (id, request_id, api_key_id, api_key_name, operation, provider, model,
         requested_count, size, quality, output_format, prompt_sha256, prompt_length,
         status, http_status, error_code, duration_ms, created_at, completed_at)
      VALUES
        (@id, @requestId, @apiKeyId, @apiKeyName, @operation, @provider, @model,
         @requestedCount, @size, @quality, @outputFormat, @promptSha256, @promptLength,
         'rejected', @httpStatus, @reason, 0, @now, @now)
    `
    )
    .run({
      id: eventId,
      requestId: input.requestId,
      apiKeyId: policy.id,
      apiKeyName: policy.name,
      operation: input.operation,
      provider: input.provider || null,
      model: input.model,
      requestedCount: Math.max(1, nonNegativeInt(input.requestedCount, 1)),
      size: input.size || null,
      quality: input.quality || null,
      outputFormat: input.outputFormat || null,
      promptSha256: prompt.promptSha256,
      promptLength: prompt.promptLength,
      httpStatus:
        reason.startsWith("image_rate_limit_") || reason.startsWith("image_concurrency_")
          ? 429
          : 403,
      reason,
      now: now.toISOString(),
    });
  return eventId;
}

function countAcceptedSince(apiKeyId: string, since: Date): number {
  const row = getDbInstance()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM image_generation_events
      WHERE api_key_id = ?
        AND status != 'rejected'
        AND created_at >= ?
    `
    )
    .get(apiKeyId, since.toISOString()) as DbRow | undefined;
  return nonNegativeInt(row?.count);
}

function countRunning(apiKeyId?: string): number {
  const row = apiKeyId
    ? (getDbInstance()
        .prepare(
          "SELECT COUNT(*) AS count FROM image_generation_events WHERE status = 'running' AND api_key_id = ?"
        )
        .get(apiKeyId) as DbRow | undefined)
    : (getDbInstance()
        .prepare("SELECT COUNT(*) AS count FROM image_generation_events WHERE status = 'running'")
        .get() as DbRow | undefined);
  return nonNegativeInt(row?.count);
}

function getPolicy(apiKeyId: string): ImagePolicyRow | null {
  return (
    (getDbInstance()
      .prepare(
        `
        SELECT id, name, image_generation_enabled, image_max_requests_per_minute,
               image_max_requests_per_day, image_max_concurrent,
               image_allow_high_quality, image_allowed_sizes
        FROM api_keys
        WHERE id = ?
      `
      )
      .get(apiKeyId) as ImagePolicyRow | undefined) || null
  );
}

function getRejectionReason(
  input: BeginImageGenerationEventInput,
  policy: ImagePolicyRow,
  now: Date
): ImageGenerationRejectionReason | null {
  if (policy.image_generation_enabled !== 1) return "image_generation_disabled";

  const quality = (input.quality || "medium").trim().toLowerCase();
  if (
    policy.image_allow_high_quality !== 1 &&
    (quality === "high" || quality === "hd" || quality === "auto")
  ) {
    return "image_high_quality_not_allowed";
  }

  const size = input.size || "1024x1024";
  if (!parseAllowedSizes(policy.image_allowed_sizes).includes(size)) {
    return "image_size_not_allowed";
  }

  const minuteLimit = nonNegativeInt(
    policy.image_max_requests_per_minute,
    DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerMinute
  );
  if (
    minuteLimit > 0 &&
    countAcceptedSince(policy.id, new Date(now.getTime() - MINUTE_WINDOW_MS)) >= minuteLimit
  ) {
    return "image_rate_limit_minute";
  }

  const dayLimit = nonNegativeInt(
    policy.image_max_requests_per_day,
    DEFAULT_IMAGE_GENERATION_POLICY.maxRequestsPerDay
  );
  if (
    dayLimit > 0 &&
    countAcceptedSince(policy.id, new Date(now.getTime() - DAY_WINDOW_MS)) >= dayLimit
  ) {
    return "image_rate_limit_day";
  }

  const keyConcurrency = positiveInt(
    policy.image_max_concurrent,
    DEFAULT_IMAGE_GENERATION_POLICY.maxConcurrent
  );
  if (countRunning(policy.id) >= keyConcurrency) return "image_concurrency_key";
  if (countRunning() >= getGlobalConcurrencyLimit()) return "image_concurrency_global";

  return null;
}

export function beginImageGenerationEvent(
  input: BeginImageGenerationEventInput
): BeginImageGenerationEventResult {
  const db = getDbInstance();
  const now = input.now || new Date();

  return db.transaction(() => {
    expireStaleRunningEvents(now);
    cleanupImageGenerationEvents(now);
    const policy = getPolicy(input.apiKeyId);
    if (!policy) {
      return {
        allowed: false as const,
        eventId: null,
        requestId: input.requestId,
        reason: "api_key_missing" as const,
      };
    }

    const rejection = getRejectionReason(input, policy, now);
    if (rejection) {
      return {
        allowed: false as const,
        eventId: insertRejectedEvent(input, policy, rejection, now),
        requestId: input.requestId,
        reason: rejection,
      };
    }

    const eventId = randomUUID();
    const prompt = promptFingerprint(input.prompt);
    db.prepare(
      `
      INSERT INTO image_generation_events
        (id, request_id, api_key_id, api_key_name, operation, provider, model,
         requested_count, size, quality, output_format, prompt_sha256, prompt_length,
         status, created_at)
      VALUES
        (@id, @requestId, @apiKeyId, @apiKeyName, @operation, @provider, @model,
         @requestedCount, @size, @quality, @outputFormat, @promptSha256, @promptLength,
         'running', @createdAt)
    `
    ).run({
      id: eventId,
      requestId: input.requestId,
      apiKeyId: policy.id,
      apiKeyName: policy.name,
      operation: input.operation,
      provider: input.provider || null,
      model: input.model,
      requestedCount: Math.max(1, nonNegativeInt(input.requestedCount, 1)),
      size: input.size || "1024x1024",
      quality: input.quality || "medium",
      outputFormat: input.outputFormat || "png",
      promptSha256: prompt.promptSha256,
      promptLength: prompt.promptLength,
      createdAt: now.toISOString(),
    });

    return { allowed: true as const, eventId, requestId: input.requestId };
  })();
}

export function completeImageGenerationEvent(input: CompleteImageGenerationEventInput): boolean {
  const now = input.now || new Date();
  const result = getDbInstance()
    .prepare(
      `
      UPDATE image_generation_events
      SET status = @status,
          http_status = @httpStatus,
          generated_count = @generatedCount,
          connection_id = @connectionId,
          upstream_request_id = @upstreamRequestId,
          error_code = @errorCode,
          duration_ms = @durationMs,
          completed_at = @completedAt
      WHERE id = @eventId AND status = 'running'
    `
    )
    .run({
      eventId: input.eventId,
      status: input.status,
      httpStatus: Math.max(100, Math.floor(input.httpStatus)),
      generatedCount: nonNegativeInt(input.generatedCount),
      connectionId: input.connectionId || null,
      upstreamRequestId: input.upstreamRequestId || null,
      errorCode: input.errorCode || null,
      durationMs: nonNegativeInt(input.durationMs),
      completedAt: now.toISOString(),
    });
  return (result.changes ?? 0) > 0;
}

function mapEvent(row: DbRow | undefined): ImageGenerationEvent | null {
  if (!row || typeof row.id !== "string" || typeof row.request_id !== "string") return null;
  return {
    id: row.id,
    requestId: row.request_id,
    apiKeyId: stringOrNull(row.api_key_id),
    apiKeyName: typeof row.api_key_name === "string" ? row.api_key_name : "Unknown key",
    operation: row.operation === "edit" ? "edit" : "generation",
    provider: stringOrNull(row.provider),
    model: typeof row.model === "string" ? row.model : "",
    connectionId: stringOrNull(row.connection_id),
    requestedCount: nonNegativeInt(row.requested_count, 1),
    generatedCount: nonNegativeInt(row.generated_count),
    size: stringOrNull(row.size),
    quality: stringOrNull(row.quality),
    outputFormat: stringOrNull(row.output_format),
    promptSha256: stringOrNull(row.prompt_sha256),
    promptLength: nonNegativeInt(row.prompt_length),
    status:
      row.status === "succeeded" ||
      row.status === "failed" ||
      row.status === "rejected" ||
      row.status === "expired"
        ? row.status
        : "running",
    httpStatus: row.http_status === null ? null : nonNegativeInt(row.http_status),
    errorCode: stringOrNull(row.error_code),
    upstreamRequestId: stringOrNull(row.upstream_request_id),
    durationMs: nonNegativeInt(row.duration_ms),
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    completedAt: stringOrNull(row.completed_at),
  };
}

export function getImageGenerationEventByRequestId(requestId: string): ImageGenerationEvent | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM image_generation_events WHERE request_id = ?")
    .get(requestId) as DbRow | undefined;
  return mapEvent(row);
}

export function cleanupImageGenerationEvents(now = new Date()): number {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_MS).toISOString();
  const result = getDbInstance()
    .prepare("DELETE FROM image_generation_events WHERE created_at < ? AND status != 'running'")
    .run(cutoff);
  return result.changes ?? 0;
}
