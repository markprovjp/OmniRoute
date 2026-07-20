import { handleImageGeneration } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import {
  getProviderCredentials,
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
  markAccountUnavailable,
} from "@/sse/services/auth";
import {
  parseImageModel,
  getAllImageModels,
  getImageProvider,
  getImageModelEntry,
} from "@omniroute/open-sse/config/imageRegistry.ts";
import {
  addVietnameseMessageToErrorPayload,
  errorResponse,
  unavailableResponse,
} from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1ImageGenerationSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagedImageApiKey } from "@/shared/utils/imageGenerationAuth";
import {
  finishManagedImageRequest,
  startManagedImageRequest,
  withManagedImageRequestId,
} from "@/shared/utils/imageGenerationControl";

import { getAllCustomModels, resolveProxyForConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";

export const maxDuration = 360;

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/images/generations — list available image models
 */
export async function GET() {
  const builtInModels = getAllImageModels();
  const timestamp = Math.floor(Date.now() / 1000);

  const data = builtInModels.map((m) => ({
    id: m.id,
    object: "model",
    created: timestamp,
    owned_by: m.provider,
    type: "image",
    supported_sizes: m.supportedSizes,
    input_modalities: m.inputModalities || ["text"],
    output_modalities: ["image"],
    ...(m.description ? { description: m.description } : {}),
  }));

  // Include custom models tagged for images
  try {
    const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
    for (const [providerId, models] of Object.entries(customModelsMap)) {
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
        if (!model.supportedEndpoints.includes("images")) continue;
        const fullId = `${providerId}/${model.id}`;
        if (data.some((d) => d.id === fullId)) continue;
        data.push({
          id: fullId,
          object: "model",
          created: timestamp,
          owned_by: providerId,
          type: "image",
          supported_sizes: null,
          input_modalities: ["text"],
          output_modalities: ["image"],
        });
      }
    }
  } catch {}

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /v1/images/generations — generate images
 */
function hasImageGenerationInput(body: Record<string, unknown>) {
  if (typeof body.image_url === "string" && body.image_url.trim()) return true;
  if (typeof body.image === "string" && body.image.trim()) return true;
  if (Array.isArray(body.imageUrls) && body.imageUrls.some((value) => typeof value === "string")) {
    return true;
  }
  if (
    Array.isArray(body.image_urls) &&
    body.image_urls.some((value) => typeof value === "string")
  ) {
    return true;
  }
  return false;
}

// Forward only the host-shaped headers the chatgpt-web image handler needs
// to derive the browser-facing public base URL. Avoid copying the full
// request header set: it's wider than the handler needs (auth tokens,
// content-type, etc.) and `Headers.forEach` collapses repeated values, which
// would silently drop entries if a wider helper were reused for headers
// that can legitimately repeat (e.g., set-cookie).
const PUBLIC_BASE_URL_HEADER_KEYS = ["host", "x-forwarded-host", "x-forwarded-proto"] as const;

function publicBaseUrlHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_BASE_URL_HEADER_KEYS) {
    const value = headers.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export async function POST(request) {
  const authentication = await requireManagedImageApiKey(request);
  if (!authentication.authenticated) return authentication.rejection;

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("IMAGE", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ImageGenerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;
  const allowedConnections =
    policy.apiKeyInfo?.allowedConnections && policy.apiKeyInfo.allowedConnections.length > 0
      ? policy.apiKeyInfo.allowedConnections
      : null;

  // Parse model to get provider
  const parsedImageModel = parseImageModel(body.model);
  let { provider } = parsedImageModel;
  let isCustomModel = false;

  // If not in built-in registry, check custom models tagged for images
  if (!provider) {
    try {
      const customModelsMap = (await getAllCustomModels()) as Record<string, any>;
      for (const [providerId, models] of Object.entries(customModelsMap)) {
        if (!Array.isArray(models)) continue;
        for (const model of models) {
          if (!model?.id || !Array.isArray(model.supportedEndpoints)) continue;
          if (!model.supportedEndpoints.includes("images")) continue;
          const fullId = `${providerId}/${model.id}`;
          if (fullId === body.model) {
            provider = providerId;
            isCustomModel = true;
            break;
          }
        }
        if (provider) break;
      }
    } catch {}
  }

  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid image model: ${body.model}. Use format: provider/model`
    );
  }

  // Check provider config for auth bypass
  const providerConfig = getImageProvider(provider);
  const imageModelEntry = getImageModelEntry(body.model);
  const inputModalities = imageModelEntry?.inputModalities || ["text"];
  const requiresPrompt = inputModalities.includes("text");
  const requiresImageInput = inputModalities.includes("image");
  const hasPrompt = typeof body.prompt === "string" && body.prompt.trim().length > 0;
  const hasImageInput = hasImageGenerationInput(body);

  if (requiresPrompt && !hasPrompt) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Prompt is required for image model: ${body.model}`
    );
  }

  if (requiresImageInput && !hasImageInput) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Image input is required for image model: ${body.model}`
    );
  }

  const admission = startManagedImageRequest({
    identity: authentication.identity,
    body,
    operation: "generation",
    provider,
    requestId: request.headers.get("x-request-id"),
  });
  if (!admission.allowed) return admission.rejection;
  const { trace } = admission;

  const isCodexImage = providerConfig?.format === "codex-responses";
  const requestedImageModel = parsedImageModel.model || body.model;
  const excludedCodexConnections = new Set<string>();
  let credentials: any = null;
  let result: any = {
    success: false,
    status: HTTP_STATUS.SERVER_ERROR,
    error: { code: "image_route_unhandled" },
  };

  try {
    while (true) {
      // Codex image generation shares the same OAuth account pool as chat. Use
      // quota-aware selection and exclude every account that fails during this
      // request so a Plus-quota 429 can immediately rotate to a healthy account.
      if (providerConfig && providerConfig.authType !== "none") {
        credentials = isCodexImage
          ? await getProviderCredentialsWithQuotaPreflight(
              provider,
              null,
              allowedConnections,
              requestedImageModel,
              { excludeConnectionIds: Array.from(excludedCodexConnections) }
            )
          : await getProviderCredentials(provider, null, allowedConnections, requestedImageModel);
        if (!credentials) {
          result = {
            success: false,
            status: HTTP_STATUS.BAD_REQUEST,
            error: { code: "image_provider_credentials_missing" },
          };
          return withManagedImageRequestId(
            errorResponse(
              HTTP_STATUS.BAD_REQUEST,
              `No credentials for image provider: ${provider}`
            ),
            trace
          );
        }
        if (credentials.allRateLimited) {
          const codexUsageLimit =
            isCodexImage &&
            /usage_limit_reached|usage limit has been reached/i.test(credentials.lastError || "");
          result = {
            success: false,
            status: HTTP_STATUS.RATE_LIMITED,
            error: { code: "image_provider_rate_limited" },
          };
          return withManagedImageRequestId(
            unavailableResponse(
              HTTP_STATUS.RATE_LIMITED,
              codexUsageLimit
                ? "All Codex accounts have reached their Plus usage limit"
                : `[${provider}] All accounts rate limited`,
              credentials.retryAfter,
              credentials.retryAfterHuman
            ),
            trace
          );
        }
      } else if (isCustomModel) {
        credentials = await getProviderCredentials(
          provider,
          null,
          allowedConnections,
          requestedImageModel
        );
        if (!credentials) {
          result = {
            success: false,
            status: HTTP_STATUS.BAD_REQUEST,
            error: { code: "image_provider_credentials_missing" },
          };
          return withManagedImageRequestId(
            errorResponse(
              HTTP_STATUS.BAD_REQUEST,
              `No credentials for custom image provider: ${provider}`
            ),
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
              `[${provider}] All accounts rate limited`,
              credentials.retryAfter,
              credentials.retryAfterHuman
            ),
            trace
          );
        }
      }

      let proxyInfo = null;
      if (credentials?.connectionId) {
        try {
          proxyInfo = await resolveProxyForConnection(credentials.connectionId);
        } catch {
          log.debug("PROXY", `Failed to resolve proxy for image provider: ${provider}`);
        }
      }

      const generateImage = () =>
        handleImageGeneration({
          body,
          credentials,
          log,
          ...(isCustomModel && { resolvedProvider: provider }),
          signal: request.signal,
          clientHeaders: publicBaseUrlHeaders(request.headers),
          trace: {
            clientRequestId: trace.requestId,
            safetyIdentifier: trace.safetyIdentifier,
            apiKeyId: trace.apiKeyId,
            apiKeyName: trace.apiKeyName,
            connectionId: credentials?.connectionId ?? null,
          },
        });

      result = await (credentials?.connectionId
        ? runWithProxyContext(proxyInfo?.proxy || null, generateImage).catch((err: any) => ({
            success: false,
            status: err.statusCode || 500,
            error: err.message,
          }))
        : generateImage());

      if (result.success) {
        await clearRecoveredProviderState(credentials);
        return withManagedImageRequestId(
          new Response(JSON.stringify(result.data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          trace
        );
      }

      if (!isCodexImage || !credentials?.connectionId) break;

      const status = Number.isInteger(result.status) ? result.status : 500;
      const errorText =
        typeof result.error === "string" ? result.error : JSON.stringify(result.error || "");
      const fallback = await markAccountUnavailable(
        credentials.connectionId,
        status,
        errorText,
        provider,
        requestedImageModel
      );
      if (!fallback.shouldFallback) break;

      excludedCodexConnections.add(credentials.connectionId);
      log.warn(
        "IMAGE",
        `${provider}/${requestedImageModel} account ${credentials.connectionId.slice(0, 8)} unavailable; retrying another Codex account`
      );
    }

    const errorPayload = addVietnameseMessageToErrorPayload(
      result.status,
      toJsonErrorPayload(result.error, "Image generation provider error")
    );
    return withManagedImageRequestId(
      new Response(JSON.stringify(errorPayload), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      }),
      trace
    );
  } catch (error) {
    result = {
      success: false,
      status: HTTP_STATUS.SERVER_ERROR,
      error: { code: "image_route_unhandled" },
    };
    log.error(
      "IMAGE",
      `Image generation route failed (${error instanceof Error ? error.name : "unknown"})`
    );
    return withManagedImageRequestId(
      errorResponse(HTTP_STATUS.SERVER_ERROR, "Image generation failed"),
      trace
    );
  } finally {
    finishManagedImageRequest(trace, result, credentials?.connectionId);
  }
}
