import { createHmac, randomUUID } from "crypto";
import {
  beginImageGenerationEvent,
  completeImageGenerationEvent,
  type ImageGenerationOperation,
  type ImageGenerationRejectionReason,
} from "@/lib/db/imageGenerationEvents";
import type { ManagedImageApiKey } from "@/shared/utils/imageGenerationAuth";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import * as log from "@/sse/utils/logger";

interface ImageRequestBody {
  model: string;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  quality?: unknown;
  output_format?: unknown;
  response_format?: unknown;
}

interface StartManagedImageRequestInput {
  identity: ManagedImageApiKey;
  body: ImageRequestBody;
  operation: ImageGenerationOperation;
  provider?: string | null;
  requestId?: unknown;
}

export interface ManagedImageRequestTrace {
  eventId: string;
  requestId: string;
  startedAt: number;
  safetyIdentifier: string | null;
  apiKeyId: string;
  apiKeyName: string;
}

export type StartManagedImageRequestResult =
  | { allowed: true; trace: ManagedImageRequestTrace }
  | { allowed: false; rejection: Response };

const REJECTION_MESSAGES: Record<ImageGenerationRejectionReason, string> = {
  api_key_missing: "Managed API key not found",
  image_generation_disabled: "Image generation is disabled for this API key",
  image_high_quality_not_allowed: "High-quality image generation is not allowed for this API key",
  image_size_not_allowed: "Requested image size is not allowed for this API key",
  image_rate_limit_minute: "Image generation minute limit exceeded for this API key",
  image_rate_limit_day: "Image generation daily limit exceeded for this API key",
  image_concurrency_key: "Image generation concurrency limit exceeded for this API key",
  image_concurrency_global: "Global image generation concurrency limit exceeded",
};

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("access-control-expose-headers", "x-request-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safetyIdentifier(apiKeyId: string): string | null {
  const secret = process.env.API_KEY_SECRET?.trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(`image-generation:${apiKeyId}`).digest("hex");
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedRequestId(value: unknown): string | null {
  const candidate = normalizedString(value);
  if (!candidate || candidate.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(candidate) ? candidate : null;
}

function requestedCount(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

export function startManagedImageRequest(
  input: StartManagedImageRequestInput
): StartManagedImageRequestResult {
  // The authz pipeline strips caller-supplied trusted headers and injects its
  // own correlation ID. Reuse that ID so response, upstream and audit records
  // all refer to the same request. Direct route tests and non-Next callers
  // still receive a generated UUID fallback.
  const requestId = normalizedRequestId(input.requestId) || randomUUID();
  let admission;
  try {
    admission = beginImageGenerationEvent({
      apiKeyId: input.identity.apiKeyInfo.id,
      apiKeyName: input.identity.apiKeyInfo.name,
      requestId,
      operation: input.operation,
      provider: input.provider || null,
      model: input.body.model,
      requestedCount: requestedCount(input.body.n),
      size: normalizedString(input.body.size),
      quality: normalizedString(input.body.quality),
      outputFormat:
        normalizedString(input.body.output_format) || normalizedString(input.body.response_format),
      prompt: normalizedString(input.body.prompt),
    });
  } catch (error) {
    log.error(
      "IMAGE_CONTROL",
      `Image admission failed (${error instanceof Error ? error.name : "unknown"})`
    );
    return {
      allowed: false,
      rejection: withRequestId(
        errorResponse(503, "Image generation admission control unavailable"),
        requestId
      ),
    };
  }

  if (!admission.allowed) {
    const status =
      admission.reason.startsWith("image_rate_limit_") ||
      admission.reason.startsWith("image_concurrency_")
        ? 429
        : admission.reason === "api_key_missing"
          ? 401
          : 403;
    const rejection = errorResponse(status, REJECTION_MESSAGES[admission.reason]);
    if (status === 429) rejection.headers.set("retry-after", "60");
    return { allowed: false, rejection: withRequestId(rejection, requestId) };
  }

  return {
    allowed: true,
    trace: {
      eventId: admission.eventId,
      requestId,
      startedAt: Date.now(),
      safetyIdentifier: safetyIdentifier(input.identity.apiKeyInfo.id),
      apiKeyId: input.identity.apiKeyInfo.id,
      apiKeyName: input.identity.apiKeyInfo.name,
    },
  };
}

function upstreamRequestId(result: Record<string, unknown>): string | null {
  const value = result.upstreamRequestId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function generatedCount(result: Record<string, unknown>): number {
  if (!result.success) return 0;
  const payload = result.data;
  if (!payload || typeof payload !== "object") return 0;
  const images = (payload as Record<string, unknown>).data;
  return Array.isArray(images) ? images.length : 0;
}

function errorCode(result: Record<string, unknown>): string | null {
  const error = result.error;
  if (error && typeof error === "object") {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) return code.slice(0, 120);
  }
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as Record<string, unknown>;
      const nested = parsed.error;
      const code =
        nested && typeof nested === "object"
          ? (nested as Record<string, unknown>).code
          : parsed.code;
      if (typeof code === "string" && code.trim()) return code.slice(0, 120);
    } catch {
      return null;
    }
  }
  return null;
}

export function finishManagedImageRequest(
  trace: ManagedImageRequestTrace,
  result: Record<string, unknown>,
  connectionId?: string | null
): void {
  const success = result.success === true;
  const rawStatus = Number(result.status);
  const httpStatus = success ? 200 : Number.isInteger(rawStatus) ? rawStatus : 500;
  try {
    completeImageGenerationEvent({
      eventId: trace.eventId,
      status: success ? "succeeded" : "failed",
      httpStatus,
      generatedCount: generatedCount(result),
      connectionId: connectionId || null,
      upstreamRequestId: upstreamRequestId(result),
      errorCode: errorCode(result),
      durationMs: Date.now() - trace.startedAt,
    });
  } catch (error) {
    // The provider response remains authoritative. A stale running lease is
    // expired by the next admission transaction so concurrency cannot leak.
    log.error(
      "IMAGE_CONTROL",
      `Image audit completion failed (${error instanceof Error ? error.name : "unknown"})`
    );
  }
}

export function withManagedImageRequestId(
  response: Response,
  trace: Pick<ManagedImageRequestTrace, "requestId">
): Response {
  return withRequestId(response, trace.requestId);
}
