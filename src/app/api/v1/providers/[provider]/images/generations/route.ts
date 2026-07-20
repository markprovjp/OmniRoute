import { handleImageGeneration } from "@omniroute/open-sse/handlers/imageGeneration.ts";
import {
  addVietnameseMessageToErrorPayload,
  errorResponse,
  unavailableResponse,
} from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getProviderCredentials, clearRecoveredProviderState } from "@/sse/services/auth";
import { getImageProvider } from "@omniroute/open-sse/config/imageRegistry.ts";
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
 * POST /v1/providers/{provider}/images/generations
 */
export async function POST(request, { params }) {
  const authentication = await requireManagedImageApiKey(request);
  if (!authentication.authenticated) return authentication.rejection;

  const { provider: rawProvider } = await params;

  // Verify this is a valid image provider
  const imageProvider = getImageProvider(rawProvider);
  if (!imageProvider) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown image provider: ${rawProvider}`);
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  const validation = validateBody(v1ImageGenerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // Ensure model has provider prefix
  if (!body.model.includes("/")) {
    body.model = `${rawProvider}/${body.model}`;
  }

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;
  const allowedConnections =
    policy.apiKeyInfo?.allowedConnections && policy.apiKeyInfo.allowedConnections.length > 0
      ? policy.apiKeyInfo.allowedConnections
      : null;

  // Validate provider match
  const modelProvider = body.model.split("/")[0];
  if (modelProvider !== rawProvider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Model "${body.model}" does not belong to image provider "${rawProvider}"`
    );
  }

  const admission = startManagedImageRequest({
    identity: authentication.identity,
    body,
    operation: "generation",
    provider: rawProvider,
    requestId: request.headers.get("x-request-id"),
  });
  if (!admission.allowed) return admission.rejection;
  const { trace } = admission;

  let credentials: any = null;
  let result: any = {
    success: false,
    status: HTTP_STATUS.SERVER_ERROR,
    error: { code: "image_route_unhandled" },
  };
  try {
    credentials = await getProviderCredentials(rawProvider, null, allowedConnections, body.model);
    if (!credentials) {
      result = {
        success: false,
        status: HTTP_STATUS.BAD_REQUEST,
        error: { code: "image_provider_credentials_missing" },
      };
      return withManagedImageRequestId(
        errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for image provider: ${rawProvider}`),
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
          `[${rawProvider}] All accounts rate limited`,
          credentials.retryAfter,
          credentials.retryAfterHuman
        ),
        trace
      );
    }

    result = await handleImageGeneration({
      body,
      credentials,
      log,
      trace: {
        clientRequestId: trace.requestId,
        safetyIdentifier: trace.safetyIdentifier,
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
      toJsonErrorPayload((result as any).error, "Image generation provider error")
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
      error: { code: "image_route_unhandled" },
    };
    log.error(
      "IMAGE",
      `Provider image route failed (${error instanceof Error ? error.name : "unknown"})`
    );
    return withManagedImageRequestId(
      errorResponse(HTTP_STATUS.SERVER_ERROR, "Image generation failed"),
      trace
    );
  } finally {
    finishManagedImageRequest(trace, result, credentials?.connectionId);
  }
}
