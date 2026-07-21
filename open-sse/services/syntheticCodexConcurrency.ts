export const CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE = "CODEX_SYNTHETIC_SESSION_CONCURRENCY_LIMIT";

const DEFAULT_MAX_CONCURRENT = 4;
const MAX_CONFIGURED_CONCURRENT = 64;

type GuardOptions = {
  maxConcurrent?: number;
};

export interface CodexSyntheticConcurrencyLease {
  release(): void;
}

export interface CodexSyntheticConcurrencyGuard {
  tryAcquire(key: string): CodexSyntheticConcurrencyLease | null;
  getActiveCount(key: string): number;
  clear(): void;
}

function clampMaxConcurrent(value: unknown, fallback = DEFAULT_MAX_CONCURRENT): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CONFIGURED_CONCURRENT, Math.max(1, Math.floor(parsed)));
}

export function getCodexSyntheticMaxConcurrent(): number {
  return clampMaxConcurrent(process.env.CODEX_SYNTHETIC_SESSION_MAX_CONCURRENCY);
}

export class CodexSyntheticConcurrencyError extends Error {
  readonly code = CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE;
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    super(
      `Codex synthetic session already has ${maxConcurrent} concurrent requests. ` +
        "Wait for an active request to finish before retrying."
    );
    this.name = "CodexSyntheticConcurrencyError";
    this.maxConcurrent = maxConcurrent;
  }
}

export function isCodexSyntheticConcurrencyError(
  error: unknown
): error is CodexSyntheticConcurrencyError {
  return (
    error instanceof CodexSyntheticConcurrencyError ||
    (error instanceof Error &&
      error.name === "CodexSyntheticConcurrencyError" &&
      (error as Error & { code?: string }).code === CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE)
  );
}

export function createCodexSyntheticConcurrencyGuard(
  options: GuardOptions = {}
): CodexSyntheticConcurrencyGuard {
  const maxConcurrent = clampMaxConcurrent(options.maxConcurrent);
  const active = new Map<string, number>();

  return {
    tryAcquire(key) {
      const current = active.get(key) ?? 0;
      if (current >= maxConcurrent) return null;

      active.set(key, current + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const next = (active.get(key) ?? 1) - 1;
          if (next <= 0) active.delete(key);
          else active.set(key, next);
        },
      };
    },
    getActiveCount(key) {
      return active.get(key) ?? 0;
    },
    clear() {
      active.clear();
    },
  };
}

const globalGuard = createCodexSyntheticConcurrencyGuard({
  maxConcurrent: getCodexSyntheticMaxConcurrent(),
});

export function buildCodexSyntheticConcurrencyKey(options: {
  provider: string | null | undefined;
  apiKeyId: string | null | undefined;
  sessionKey: string | null | undefined;
  stream: boolean;
}): string | null {
  if (options.provider !== "codex" || options.stream) return null;
  if (!options.sessionKey?.startsWith("input:sha256:")) return null;
  const apiKeyId = options.apiKeyId?.trim();
  if (!apiKeyId) return null;
  return `${apiKeyId}:${options.sessionKey}`;
}

export function acquireCodexSyntheticConcurrency(key: string): CodexSyntheticConcurrencyLease {
  const lease = globalGuard.tryAcquire(key);
  if (!lease) {
    throw new CodexSyntheticConcurrencyError(getCodexSyntheticMaxConcurrent());
  }
  return lease;
}

export async function runWithCodexSyntheticConcurrency<T>(
  key: string | null,
  execute: () => Promise<T>
): Promise<T> {
  if (!key) return execute();

  const lease = acquireCodexSyntheticConcurrency(key);
  try {
    return await execute();
  } finally {
    lease.release();
  }
}

export function __clearCodexSyntheticConcurrencyForTesting(): void {
  globalGuard.clear();
}
