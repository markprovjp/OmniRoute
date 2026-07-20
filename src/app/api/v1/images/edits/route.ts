import { handleImageEdit } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import { getProviderCredentials, clearRecoveredProviderState } from "@/sse/services/auth";
import { parseImageModel, getImageProvider } from "@omniroute/open-sse/config/imageRegistry.ts";
import {
  addVietnameseMessageToErrorPayload,
  errorResponse,
  unavailableResponse,
} from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { requireManagedImageApiKey } from "@/shared/utils/imageGenerationAuth";
import {
  finishManagedImageRequest,
  startManagedImageRequest,
  withManagedImageRequestId,
} from "@/shared/utils/imageGenerationControl";

/**
 * /v1/images/edits — multipart edit endpoint matching OpenAI's images-edit API.
 *
 * Open WebUI's "Image Edit" toggle (images.edit.engine = "openai") posts here
 * with `prompt` + `image` (file). For chatgpt-web, an "edit" only makes sense
 * if the uploaded image was originally generated through OmniRoute — we then
 * have its `{conversationId, parentMessageId}` cached and can continue the
 * saved chatgpt.com conversation node, which is the only way to actually edit
 * the image instead of generating an unrelated one from scratch.
 *
 * Without this route, multipart bodies trip Next.js's Server Action handler
 * (which intercepts ALL POSTs with multipart/form-data content-type) and the
 * client gets a confusing "Failed to find Server Action" 500.
 */

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

const PUBLIC_BASE_URL_HEADER_KEYS = ["host", "x-forwarded-host", "x-forwarded-proto"] as const;
const MAX_IMAGE_EDIT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDIT_REQUEST_BYTES = 22 * 1024 * 1024;

class ImageEditRequestTooLargeError extends Error {
  constructor() {
    super("Image edit request is too large");
    this.name = "ImageEditRequestTooLargeError";
  }
}

function publicBaseUrlHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_BASE_URL_HEADER_KEYS) {
    const value = headers.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

async function readBoundedMultipartFormData(request: Request): Promise<FormData> {
  if (!request.body) return request.formData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_EDIT_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ImageEditRequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = request.headers.get("content-type");
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  return new Request(request.url, { method: "POST", headers, body }).formData();
}

async function readMultipartImage(formData: FormData): Promise<{
  prompt: string;
  model: string | null;
  size: string | null;
  responseFormat: string | null;
  imageBytes: Buffer | null;
  imageMime: string | null;
}> {
  const promptRaw = formData.get("prompt");
  const prompt = typeof promptRaw === "string" ? promptRaw.trim() : "";
  const modelRaw = formData.get("model");
  const model = typeof modelRaw === "string" ? modelRaw.trim() : null;
  const sizeRaw = formData.get("size");
  const size = typeof sizeRaw === "string" ? sizeRaw.trim() : null;
  const respRaw = formData.get("response_format");
  const responseFormat = typeof respRaw === "string" ? respRaw.trim() : null;

  // OpenAI's API and Open WebUI both accept either a single `image` field or
  // an `image[]` array. We use the first image when multiple are sent — the
  // chatgpt-web edit tool can only edit one image per conversation node.
  const imageEntry = formData.get("image") ?? formData.get("image[]");
  if (!imageEntry || typeof imageEntry === "string") {
    return { prompt, model, size, responseFormat, imageBytes: null, imageMime: null };
  }
  const file = imageEntry as File;
  const imageBytes = Buffer.from(await file.arrayBuffer());
  const imageMime = file.type || "image/png";
  return { prompt, model, size, responseFormat, imageBytes, imageMime };
}

export async function POST(request: Request) {
  const authentication = await requireManagedImageApiKey(request);
  if (!authentication.authenticated) return authentication.rejection;

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_EDIT_REQUEST_BYTES) {
    return errorResponse(413, "Image edit request is too large");
  }

  let formData: FormData;
  try {
    formData = await readBoundedMultipartFormData(request);
  } catch (error) {
    if (error instanceof ImageEditRequestTooLargeError) {
      return errorResponse(413, "Image edit request is too large");
    }
    log.warn(
      "IMAGE",
      `Invalid multipart body (${error instanceof Error ? error.name : "unknown"})`
    );
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart body");
  }

  const { prompt, model, size, responseFormat, imageBytes, imageMime } =
    await readMultipartImage(formData);

  if (!prompt) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }
  if (!imageBytes || imageBytes.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  }
  if (imageBytes.length > MAX_IMAGE_EDIT_BYTES) {
    return errorResponse(413, "Image file is too large");
  }

  const fullModel = model || "cgpt-web/gpt-5.3-instant";

  const policy = await enforceApiKeyPolicy(request, fullModel);
  if (policy.rejection) return policy.rejection;

  const parsed = parseImageModel(fullModel);
  const providerConfig = getImageProvider(parsed.provider);
  if (!providerConfig) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown image provider: ${parsed.provider}`);
  }
  if (providerConfig.format !== "chatgpt-web") {
    // We only implement edit for chatgpt-web today; everything else routes
    // through generations which doesn't accept image inputs. Surface a
    // useful error rather than silently dropping the image.
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Image edit is only supported for chatgpt-web models (got ${parsed.provider})`
    );
  }

  const editBody = {
    model: fullModel,
    prompt,
    size: size ?? undefined,
    response_format: responseFormat ?? undefined,
    n: 1,
  };
  const admission = startManagedImageRequest({
    identity: authentication.identity,
    body: editBody,
    operation: "edit",
    provider: parsed.provider,
    requestId: request.headers.get("x-request-id"),
  });
  if (!admission.allowed) return admission.rejection;
  const { trace } = admission;

  const allowedConnections =
    policy.apiKeyInfo?.allowedConnections && policy.apiKeyInfo.allowedConnections.length > 0
      ? policy.apiKeyInfo.allowedConnections
      : null;
  let credentials: any = null;
  let result: any = {
    success: false,
    status: HTTP_STATUS.SERVER_ERROR,
    error: { code: "image_edit_route_unhandled" },
  };
  try {
    credentials = await getProviderCredentials(
      parsed.provider,
      null,
      allowedConnections,
      fullModel
    );
    if (!credentials) {
      result = {
        success: false,
        status: HTTP_STATUS.UNAUTHORIZED,
        error: { code: "image_provider_credentials_missing" },
      };
      return withManagedImageRequestId(
        errorResponse(HTTP_STATUS.UNAUTHORIZED, `No credentials for provider: ${parsed.provider}`),
        trace
      );
    }
    if (credentials.allRateLimited) {
      result = {
        success: false,
        status: HTTP_STATUS.RATE_LIMITED,
        error: { code: "image_provider_rate_limited" },
      };
      return withManagedImageRequestId(
        unavailableResponse(
          HTTP_STATUS.RATE_LIMITED,
          `[${parsed.provider}] All accounts rate limited`,
          credentials.retryAfter,
          credentials.retryAfterHuman
        ),
        trace
      );
    }

    result = await handleImageEdit({
      provider: parsed.provider,
      model: parsed.model,
      body: editBody,
      imageBytes,
      imageMime,
      credentials,
      log,
      signal: request.signal,
      clientHeaders: publicBaseUrlHeaders(request.headers),
      trace: {
        apiKeyId: trace.apiKeyId,
        apiKeyName: trace.apiKeyName,
        connectionId: credentials?.connectionId ?? null,
      },
    });

    if (result.success) {
      await clearRecoveredProviderState(credentials);
      return withManagedImageRequestId(
        new Response(JSON.stringify((result as any).data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        trace
      );
    }

    const errorPayload = addVietnameseMessageToErrorPayload(
      (result as any).status,
      toJsonErrorPayload((result as any).error, "Image edit provider error")
    );
    return withManagedImageRequestId(
      new Response(JSON.stringify(errorPayload), {
        status: (result as any).status,
        headers: { "Content-Type": "application/json" },
      }),
      trace
    );
  } catch (error) {
    result = {
      success: false,
      status: HTTP_STATUS.SERVER_ERROR,
      error: { code: "image_edit_route_unhandled" },
    };
    log.error(
      "IMAGE",
      `Image edit route failed (${error instanceof Error ? error.name : "unknown"})`
    );
    return withManagedImageRequestId(
      errorResponse(HTTP_STATUS.SERVER_ERROR, "Image edit failed"),
      trace
    );
  } finally {
    finishManagedImageRequest(trace, result, credentials?.connectionId);
  }
}
