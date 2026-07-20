import { getApiKeyMetadata } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import * as log from "@/sse/utils/logger";

export interface ManagedImageApiKey {
  apiKey: string;
  apiKeyInfo: NonNullable<Awaited<ReturnType<typeof getApiKeyMetadata>>>;
}

export type ManagedImageApiKeyResult =
  | { authenticated: true; identity: ManagedImageApiKey }
  | { authenticated: false; rejection: Response };

export async function requireManagedImageApiKey(
  request: Request
): Promise<ManagedImageApiKeyResult> {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return {
      authenticated: false,
      rejection: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required"),
    };
  }

  let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  try {
    apiKeyInfo = await getApiKeyMetadata(apiKey);
  } catch (error) {
    log.error(
      "IMAGE_AUTH",
      `Managed image API key lookup failed (${error instanceof Error ? error.name : "unknown"})`
    );
    return {
      authenticated: false,
      rejection: errorResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "API key authentication unavailable"
      ),
    };
  }

  if (!apiKeyInfo || apiKeyInfo.id === "env-key" || apiKeyInfo.revokedAt) {
    return {
      authenticated: false,
      rejection: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"),
    };
  }

  const expiresAt = apiKeyInfo.expiresAt ? Date.parse(apiKeyInfo.expiresAt) : Number.NaN;
  const policyWillRejectLifecycle =
    apiKeyInfo.isActive === false ||
    apiKeyInfo.isBanned === true ||
    (Number.isFinite(expiresAt) && expiresAt <= Date.now());
  if (!policyWillRejectLifecycle && !(await isValidApiKey(apiKey))) {
    return {
      authenticated: false,
      rejection: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"),
    };
  }

  return { authenticated: true, identity: { apiKey, apiKeyInfo } };
}
