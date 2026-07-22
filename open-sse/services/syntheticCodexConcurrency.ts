export const CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE = "CODEX_SYNTHETIC_SESSION_CONCURRENCY_LIMIT";
export const CODEX_API_KEY_CONCURRENCY_ERROR_CODE = "CODEX_API_KEY_CONCURRENCY_LIMIT";
export const CODEX_PROCESS_CONCURRENCY_ERROR_CODE = "CODEX_PROCESS_CONCURRENCY_LIMIT";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_API_KEY_MAX_CONCURRENT = 4;
const DEFAULT_PROCESS_MAX_CONCURRENT = 6;
const MAX_CONFIGURED_CONCURRENT = 64;

type GuardOptions = {
  maxConcurrent?: number;
};

type CodexRequestConcurrencyOptions = {
  processMaxConcurrent?: number;
  apiKeyMaxConcurrent?: number;
  syntheticMaxConcurrent?: number;
};

type CodexRequestDescriptor = {
  provider: string | null | undefined;
  apiKeyId: string | null | undefined;
  sessionKey: string | null | undefined;
  stream: boolean;
};

export interface CodexSyntheticConcurrencyLease {
  release(): void;
}

export interface CodexSyntheticConcurrencyGuard {
  tryAcquire(key: string): CodexSyntheticConcurrencyLease | null;
  getActiveCount(key: string): number;
  clear(): void;
}

export interface CodexRequestConcurrencyController {
  acquire(options: CodexRequestDescriptor): CodexSyntheticConcurrencyLease;
  getProcessActiveCount(): number;
  getApiKeyActiveCount(apiKeyId: string): number;
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

export function getCodexApiKeyMaxConcurrent(): number {
  return clampMaxConcurrent(
    process.env.CODEX_API_KEY_MAX_CONCURRENCY,
    DEFAULT_API_KEY_MAX_CONCURRENT
  );
}

export function getCodexProcessMaxConcurrent(): number {
  return clampMaxConcurrent(
    process.env.CODEX_PROCESS_MAX_CONCURRENCY,
    DEFAULT_PROCESS_MAX_CONCURRENT
  );
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

export class CodexRequestConcurrencyError extends Error {
  readonly code: string;
  readonly scope: "api_key" | "process";
  readonly maxConcurrent: number;

  constructor(scope: "api_key" | "process", maxConcurrent: number) {
    const code =
      scope === "api_key"
        ? CODEX_API_KEY_CONCURRENCY_ERROR_CODE
        : CODEX_PROCESS_CONCURRENCY_ERROR_CODE;
    const label = scope === "api_key" ? "API key" : "process";
    super(
      `Codex ${label} concurrency is limited to ${maxConcurrent} active requests. ` +
        "Wait for an active request to finish before retrying."
    );
    this.name = "CodexRequestConcurrencyError";
    this.code = code;
    this.scope = scope;
    this.maxConcurrent = maxConcurrent;
  }
}

export function isCodexRequestConcurrencyError(
  error: unknown
): error is CodexRequestConcurrencyError {
  if (error instanceof CodexRequestConcurrencyError) return true;
  if (!(error instanceof Error) || error.name !== "CodexRequestConcurrencyError") return false;
  const code = (error as Error & { code?: string }).code;
  return (
    code === CODEX_API_KEY_CONCURRENCY_ERROR_CODE || code === CODEX_PROCESS_CONCURRENCY_ERROR_CODE
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

export function createCodexRequestConcurrencyController(
  options: CodexRequestConcurrencyOptions = {}
): CodexRequestConcurrencyController {
  const processMaxConcurrent = clampMaxConcurrent(
    options.processMaxConcurrent,
    DEFAULT_PROCESS_MAX_CONCURRENT
  );
  const apiKeyMaxConcurrent = clampMaxConcurrent(
    options.apiKeyMaxConcurrent,
    DEFAULT_API_KEY_MAX_CONCURRENT
  );
  const syntheticMaxConcurrent = clampMaxConcurrent(
    options.syntheticMaxConcurrent,
    DEFAULT_MAX_CONCURRENT
  );
  const processGuard = createCodexSyntheticConcurrencyGuard({
    maxConcurrent: processMaxConcurrent,
  });
  const apiKeyGuard = createCodexSyntheticConcurrencyGuard({
    maxConcurrent: apiKeyMaxConcurrent,
  });
  const syntheticGuard = createCodexSyntheticConcurrencyGuard({
    maxConcurrent: syntheticMaxConcurrent,
  });

  return {
    acquire(descriptor) {
      if (descriptor.provider !== "codex") {
        return { release() {} };
      }

      const leases: CodexSyntheticConcurrencyLease[] = [];
      const releaseAcquired = () => {
        for (let index = leases.length - 1; index >= 0; index--) {
          leases[index].release();
        }
      };

      const processLease = processGuard.tryAcquire("process");
      if (!processLease) {
        throw new CodexRequestConcurrencyError("process", processMaxConcurrent);
      }
      leases.push(processLease);

      const apiKeyId = descriptor.apiKeyId?.trim();
      if (apiKeyId) {
        const apiKeyLease = apiKeyGuard.tryAcquire(apiKeyId);
        if (!apiKeyLease) {
          releaseAcquired();
          throw new CodexRequestConcurrencyError("api_key", apiKeyMaxConcurrent);
        }
        leases.push(apiKeyLease);
      }

      const syntheticKey = buildCodexSyntheticConcurrencyKey(descriptor);
      if (syntheticKey) {
        const syntheticLease = syntheticGuard.tryAcquire(syntheticKey);
        if (!syntheticLease) {
          releaseAcquired();
          throw new CodexSyntheticConcurrencyError(syntheticMaxConcurrent);
        }
        leases.push(syntheticLease);
      }

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          releaseAcquired();
        },
      };
    },
    getProcessActiveCount() {
      return processGuard.getActiveCount("process");
    },
    getApiKeyActiveCount(apiKeyId) {
      const normalized = apiKeyId.trim();
      return normalized ? apiKeyGuard.getActiveCount(normalized) : 0;
    },
    clear() {
      processGuard.clear();
      apiKeyGuard.clear();
      syntheticGuard.clear();
    },
  };
}

const globalRequestController = createCodexRequestConcurrencyController({
  processMaxConcurrent: getCodexProcessMaxConcurrent(),
  apiKeyMaxConcurrent: getCodexApiKeyMaxConcurrent(),
  syntheticMaxConcurrent: getCodexSyntheticMaxConcurrent(),
});

export function acquireCodexRequestConcurrency(
  descriptor: CodexRequestDescriptor
): CodexSyntheticConcurrencyLease {
  return globalRequestController.acquire(descriptor);
}

export function holdCodexConcurrencyUntilResponseBodyCompletes(
  response: Response,
  lease: CodexSyntheticConcurrencyLease
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
        // The downstream cancellation is already complete.
      }
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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

export function __clearCodexRequestConcurrencyForTesting(): void {
  globalRequestController.clear();
}
