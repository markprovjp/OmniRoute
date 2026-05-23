const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isApiKeyRevealEnabled(): boolean {
  const raw = String(process.env.ALLOW_API_KEY_REVEAL || "")
    .trim()
    .toLowerCase();
  if (raw) return ENABLED_VALUES.has(raw);
  return process.env.NODE_ENV !== "production";
}

export function maskStoredApiKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  return key.slice(0, 8) + "****" + key.slice(-4);
}
