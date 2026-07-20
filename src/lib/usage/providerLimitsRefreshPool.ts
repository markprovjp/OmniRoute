export interface ProviderLimitsPoolConnection {
  id: string;
  provider: string;
}

export interface ProviderLimitsPoolOptions<TConnection, TResult> {
  globalConcurrency?: number;
  perProviderConcurrency?: number;
  onSettled?: (
    connection: TConnection,
    result: PromiseSettledResult<TResult>
  ) => void | Promise<void>;
}

export interface ProviderLimitsPoolSummary {
  total: number;
  succeeded: number;
  failed: number;
  peakGlobalConcurrency: number;
  peakProviderConcurrency: Record<string, number>;
}

const MAX_GLOBAL_CONCURRENCY = 256;
const MAX_PROVIDER_CONCURRENCY = 64;

interface IndexedProviderQueue<TConnection> {
  items: TConnection[];
  nextIndex: number;
}

function clampConcurrency(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

/**
 * Run I/O-bound provider work without fixed batch barriers.
 *
 * Queues are grouped by provider and selected round-robin. Whenever one task
 * settles, its slot is filled immediately while global and per-provider caps
 * remain enforced.
 */
export function runProviderLimitsRefreshPool<
  TConnection extends ProviderLimitsPoolConnection,
  TResult,
>(
  connections: readonly TConnection[],
  worker: (connection: TConnection) => Promise<TResult>,
  options: ProviderLimitsPoolOptions<TConnection, TResult> = {}
): Promise<ProviderLimitsPoolSummary> {
  const globalConcurrency = clampConcurrency(options.globalConcurrency, 32, MAX_GLOBAL_CONCURRENCY);
  const perProviderConcurrency = clampConcurrency(
    options.perProviderConcurrency,
    5,
    MAX_PROVIDER_CONCURRENCY
  );

  if (connections.length === 0) {
    return Promise.resolve({
      total: 0,
      succeeded: 0,
      failed: 0,
      peakGlobalConcurrency: 0,
      peakProviderConcurrency: {},
    });
  }

  const queues = new Map<string, IndexedProviderQueue<TConnection>>();
  for (const connection of connections) {
    const queue = queues.get(connection.provider);
    if (queue) queue.items.push(connection);
    else queues.set(connection.provider, { items: [connection], nextIndex: 0 });
  }

  const providerOrder = [...queues.keys()];
  const activeByProvider = new Map(providerOrder.map((provider) => [provider, 0]));
  const peakProviderConcurrency: Record<string, number> = Object.fromEntries(
    providerOrder.map((provider) => [provider, 0])
  );

  let providerCursor = 0;
  let activeGlobal = 0;
  let peakGlobalConcurrency = 0;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let callbackError: unknown = null;

  function takeNext(): TConnection | null {
    for (let offset = 0; offset < providerOrder.length; offset += 1) {
      const index = (providerCursor + offset) % providerOrder.length;
      const provider = providerOrder[index];
      const queue = queues.get(provider);
      if (!queue || queue.nextIndex >= queue.items.length) continue;
      if ((activeByProvider.get(provider) || 0) >= perProviderConcurrency) continue;

      providerCursor = (index + 1) % providerOrder.length;
      const connection = queue.items[queue.nextIndex];
      queue.nextIndex += 1;
      return connection;
    }
    return null;
  }

  return new Promise<ProviderLimitsPoolSummary>((resolve, reject) => {
    const finishIfDone = () => {
      if (completed !== connections.length || activeGlobal !== 0) return false;
      if (callbackError) {
        reject(callbackError);
        return true;
      }
      resolve({
        total: connections.length,
        succeeded,
        failed,
        peakGlobalConcurrency,
        peakProviderConcurrency,
      });
      return true;
    };

    const pump = () => {
      if (finishIfDone()) return;

      while (activeGlobal < globalConcurrency) {
        const connection = takeNext();
        if (!connection) break;

        const provider = connection.provider;
        activeGlobal += 1;
        const providerActive = (activeByProvider.get(provider) || 0) + 1;
        activeByProvider.set(provider, providerActive);
        peakGlobalConcurrency = Math.max(peakGlobalConcurrency, activeGlobal);
        peakProviderConcurrency[provider] = Math.max(
          peakProviderConcurrency[provider] || 0,
          providerActive
        );

        void Promise.resolve()
          .then(() => worker(connection))
          .then(
            async (value) => {
              succeeded += 1;
              await options.onSettled?.(connection, { status: "fulfilled", value });
            },
            async (reason) => {
              failed += 1;
              await options.onSettled?.(connection, { status: "rejected", reason });
            }
          )
          .catch((error) => {
            callbackError ||= error;
          })
          .finally(() => {
            activeGlobal -= 1;
            activeByProvider.set(provider, Math.max(0, (activeByProvider.get(provider) || 1) - 1));
            completed += 1;
            queueMicrotask(pump);
          });
      }
    };

    pump();
  });
}
