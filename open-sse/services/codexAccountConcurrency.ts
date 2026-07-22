export const CODEX_ACCOUNT_CONCURRENCY_ERROR_CODE = "CODEX_ACCOUNT_CONCURRENCY_LIMIT";

const DEFAULT_ACCOUNT_MAX_CONCURRENT = 1;
const MAX_CONFIGURED_CONCURRENT = 64;

export interface CodexAccountConcurrencyLease {
  release(): void;
}

export interface CodexAccountConcurrencyRegistry {
  tryAcquire(
    connectionId: string,
    maxConcurrent?: number | null
  ): CodexAccountConcurrencyLease | null;
  getActiveCount(connectionId: string): number;
  isAtCapacity(connectionId: string, maxConcurrent?: number | null): boolean;
  clear(): void;
}

interface RegistryOptions {
  defaultMaxConcurrent?: number;
}

function clampMaxConcurrent(value: unknown, fallback = DEFAULT_ACCOUNT_MAX_CONCURRENT): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_CONFIGURED_CONCURRENT, Math.max(1, Math.floor(parsed)));
}

export function getCodexAccountMaxConcurrent(configured?: number | null): number {
  if (configured != null) {
    return clampMaxConcurrent(configured);
  }
  return clampMaxConcurrent(
    process.env.CODEX_ACCOUNT_MAX_CONCURRENCY,
    DEFAULT_ACCOUNT_MAX_CONCURRENT
  );
}

export class CodexAccountConcurrencyError extends Error {
  readonly code = CODEX_ACCOUNT_CONCURRENCY_ERROR_CODE;
  readonly connectionId: string;
  readonly maxConcurrent: number;

  constructor(connectionId: string, maxConcurrent: number) {
    super(`Codex account is already handling ${maxConcurrent} active request(s).`);
    this.name = "CodexAccountConcurrencyError";
    this.connectionId = connectionId;
    this.maxConcurrent = maxConcurrent;
  }
}

export function isCodexAccountConcurrencyError(
  error: unknown
): error is CodexAccountConcurrencyError {
  return (
    error instanceof CodexAccountConcurrencyError ||
    (error instanceof Error &&
      error.name === "CodexAccountConcurrencyError" &&
      (error as Error & { code?: string }).code === CODEX_ACCOUNT_CONCURRENCY_ERROR_CODE)
  );
}

export function createCodexAccountConcurrencyRegistry(
  options: RegistryOptions = {}
): CodexAccountConcurrencyRegistry {
  const defaultMaxConcurrent = clampMaxConcurrent(options.defaultMaxConcurrent);
  const active = new Map<string, number>();
  const normalizeConnectionId = (connectionId: string) => connectionId.trim();
  const resolveMaxConcurrent = (maxConcurrent?: number | null) =>
    maxConcurrent == null
      ? defaultMaxConcurrent
      : clampMaxConcurrent(maxConcurrent, defaultMaxConcurrent);

  return {
    tryAcquire(connectionId, maxConcurrent) {
      const key = normalizeConnectionId(connectionId);
      if (!key) return null;

      const limit = resolveMaxConcurrent(maxConcurrent);
      const current = active.get(key) ?? 0;
      if (current >= limit) return null;

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
    getActiveCount(connectionId) {
      const key = normalizeConnectionId(connectionId);
      return key ? (active.get(key) ?? 0) : 0;
    },
    isAtCapacity(connectionId, maxConcurrent) {
      const key = normalizeConnectionId(connectionId);
      if (!key) return false;
      return (active.get(key) ?? 0) >= resolveMaxConcurrent(maxConcurrent);
    },
    clear() {
      active.clear();
    },
  };
}

const globalRegistry = createCodexAccountConcurrencyRegistry({
  defaultMaxConcurrent: getCodexAccountMaxConcurrent(),
});

export function getCodexAccountActiveCount(connectionId: string): number {
  return globalRegistry.getActiveCount(connectionId);
}

export function isCodexAccountAtCapacity(
  connectionId: string,
  maxConcurrent?: number | null
): boolean {
  return globalRegistry.isAtCapacity(connectionId, maxConcurrent);
}

export function acquireCodexAccountConcurrency(
  connectionId: string,
  maxConcurrent?: number | null
): CodexAccountConcurrencyLease {
  const limit = getCodexAccountMaxConcurrent(maxConcurrent);
  const lease = globalRegistry.tryAcquire(connectionId, limit);
  if (!lease) {
    throw new CodexAccountConcurrencyError(connectionId, limit);
  }
  return lease;
}

export function holdCodexAccountConcurrencyUntilResponseBodyCompletes(
  response: Response,
  lease: CodexAccountConcurrencyLease
): Response {
  const body = response.body;
  if (!body) {
    lease.release();
    return response;
  }

  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      try {
        await reader.cancel(reason);
      } catch {
        // The concurrency lease is already released; cancellation is best-effort.
      }
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function __clearCodexAccountConcurrencyForTesting(): void {
  globalRegistry.clear();
}
