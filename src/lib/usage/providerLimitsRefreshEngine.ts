import {
  runProviderLimitsRefreshPool,
  type ProviderLimitsPoolConnection,
} from "./providerLimitsRefreshPool";

export interface ProviderLimitsRefreshSuccess<TCache> {
  connectionId: string;
  provider: string;
  status: "succeeded";
  cache: TCache;
}

export interface ProviderLimitsRefreshFailure {
  connectionId: string;
  provider: string;
  status: "failed";
  error: string;
}

export type ProviderLimitsRefreshEvent<TCache> =
  | ProviderLimitsRefreshSuccess<TCache>
  | ProviderLimitsRefreshFailure;

export interface ProviderLimitsRefreshEngineOptions<
  TConnection extends ProviderLimitsPoolConnection,
  TCache,
> {
  connections: readonly TConnection[];
  refresh: (connection: TConnection) => Promise<TCache>;
  persistBatch: (entries: Array<{ connectionId: string; entry: TCache }>) => void | Promise<void>;
  onProgress?: (event: ProviderLimitsRefreshEvent<TCache>) => void | Promise<void>;
  formatError?: (error: unknown) => string;
  globalConcurrency?: number;
  perProviderConcurrency?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  refreshTimeoutMs?: number;
}

export interface ProviderLimitsRefreshEngineSummary {
  total: number;
  succeeded: number;
  failed: number;
  peakGlobalConcurrency: number;
  peakProviderConcurrency: Record<string, number>;
  batchFlushes: number;
}

interface PendingSuccess<TConnection, TCache> {
  connection: TConnection;
  cache: TCache;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Failed to refresh provider limits";
}

async function runWithRefreshTimeout<T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Provider limits refresh timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([Promise.resolve().then(factory), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runProviderLimitsRefreshEngine<
  TConnection extends ProviderLimitsPoolConnection,
  TCache,
>(
  options: ProviderLimitsRefreshEngineOptions<TConnection, TCache>
): Promise<ProviderLimitsRefreshEngineSummary> {
  const batchSize = clampInteger(options.batchSize, 25, 1, 1_000);
  const flushIntervalMs = clampInteger(options.flushIntervalMs, 100, 10, 60_000);
  const refreshTimeoutMs = clampInteger(options.refreshTimeoutMs, 60_000, 10, 300_000);
  const pending: Array<PendingSuccess<TConnection, TCache>> = [];
  let flushChain = Promise.resolve();
  let succeeded = 0;
  let failed = 0;
  let batchFlushes = 0;

  const emit = async (event: ProviderLimitsRefreshEvent<TCache>) => {
    await options.onProgress?.(event);
  };

  const queueFlush = (force: boolean): Promise<void> => {
    const next = flushChain.then(async () => {
      while (pending.length > 0 && (force || pending.length >= batchSize)) {
        const batch = pending.splice(0, batchSize);
        try {
          await options.persistBatch(
            batch.map(({ connection, cache }) => ({
              connectionId: connection.id,
              entry: cache,
            }))
          );
          batchFlushes += 1;
          for (const { connection, cache } of batch) {
            succeeded += 1;
            await emit({
              connectionId: connection.id,
              provider: connection.provider,
              status: "succeeded",
              cache,
            });
          }
        } catch {
          for (const { connection } of batch) {
            failed += 1;
            await emit({
              connectionId: connection.id,
              provider: connection.provider,
              status: "failed",
              error: "Failed to persist refreshed quota",
            });
          }
        }
      }
    });
    flushChain = next.catch(() => undefined);
    return next;
  };

  const timer = setInterval(() => {
    void queueFlush(true);
  }, flushIntervalMs);
  timer.unref?.();

  try {
    const pool = await runProviderLimitsRefreshPool(
      options.connections,
      (connection) => runWithRefreshTimeout(() => options.refresh(connection), refreshTimeoutMs),
      {
        globalConcurrency: options.globalConcurrency,
        perProviderConcurrency: options.perProviderConcurrency,
        onSettled: async (connection, result) => {
          if (result.status === "fulfilled") {
            pending.push({ connection, cache: result.value });
            if (pending.length >= batchSize) await queueFlush(false);
            return;
          }

          failed += 1;
          await emit({
            connectionId: connection.id,
            provider: connection.provider,
            status: "failed",
            error: (options.formatError || defaultErrorMessage)(result.reason),
          });
        },
      }
    );

    await queueFlush(true);
    await flushChain;

    return {
      total: options.connections.length,
      succeeded,
      failed,
      peakGlobalConcurrency: pool.peakGlobalConcurrency,
      peakProviderConcurrency: pool.peakProviderConcurrency,
      batchFlushes,
    };
  } finally {
    clearInterval(timer);
  }
}

export interface ProviderLimitsSingleFlight<T> {
  run(key: string, factory: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createProviderLimitsSingleFlight<T>(): ProviderLimitsSingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key, factory) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      let source: Promise<T>;
      try {
        source = Promise.resolve(factory());
      } catch (error) {
        source = Promise.reject(error);
      }

      const tracked = source.finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },
    size() {
      return inFlight.size;
    },
  };
}
