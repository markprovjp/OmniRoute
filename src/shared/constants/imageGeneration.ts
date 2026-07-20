export const IMAGE_GENERATION_ALLOWED_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export type ImageGenerationAllowedSize = (typeof IMAGE_GENERATION_ALLOWED_SIZES)[number];

export const DEFAULT_IMAGE_GENERATION_POLICY = {
  enabled: true,
  maxRequestsPerMinute: 2,
  maxRequestsPerDay: 10,
  maxConcurrent: 1,
  allowHighQuality: false,
  allowedSizes: [...IMAGE_GENERATION_ALLOWED_SIZES],
} as const;

export const DEFAULT_IMAGE_GLOBAL_CONCURRENCY = 8;
export const IMAGE_GENERATION_MAX_TIMEOUT_MS = 180_000;
