import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderLimitsSingleFlight,
  runProviderLimitsRefreshEngine,
} from "../../src/lib/usage/providerLimitsRefreshEngine.ts";

interface TestConnection {
  id: string;
  provider: string;
}

interface TestCache {
  fetchedAt: string;
  quotas: Record<string, unknown>;
}

test("refresh engine persists successful quota results in bounded batches", async () => {
  const connections: TestConnection[] = Array.from({ length: 5 }, (_, index) => ({
    id: `connection-${index}`,
    provider: index % 2 === 0 ? "alpha" : "beta",
  }));
  const persistedBatches: string[][] = [];
  const progress: string[] = [];

  const summary = await runProviderLimitsRefreshEngine<TestConnection, TestCache>({
    connections,
    refresh: async (connection) => ({
      fetchedAt: "2026-07-20T00:00:00.000Z",
      quotas: { connectionId: connection.id },
    }),
    persistBatch: async (entries) => {
      persistedBatches.push(entries.map((entry) => entry.connectionId));
    },
    onProgress: (event) => {
      progress.push(`${event.status}:${event.connectionId}`);
    },
    globalConcurrency: 4,
    perProviderConcurrency: 2,
    batchSize: 2,
    flushIntervalMs: 60_000,
  });

  assert.deepEqual(
    persistedBatches.map((batch) => batch.length),
    [2, 2, 1]
  );
  assert.equal(new Set(persistedBatches.flat()).size, connections.length);
  assert.equal(progress.length, connections.length);
  assert.equal(
    progress.every((event) => event.startsWith("succeeded:")),
    true
  );
  assert.deepEqual(summary, {
    total: 5,
    succeeded: 5,
    failed: 0,
    peakGlobalConcurrency: 4,
    peakProviderConcurrency: { alpha: 2, beta: 2 },
    batchFlushes: 3,
  });
});

test("refresh engine reports failures without persisting failed entries", async () => {
  const persisted: string[] = [];
  const events: Array<{ connectionId: string; status: string; error?: string }> = [];
  const connections: TestConnection[] = [
    { id: "ok", provider: "alpha" },
    { id: "bad", provider: "alpha" },
  ];

  const summary = await runProviderLimitsRefreshEngine<TestConnection, TestCache>({
    connections,
    refresh: async (connection) => {
      if (connection.id === "bad") throw new Error("provider request failed");
      return { fetchedAt: "2026-07-20T00:00:00.000Z", quotas: {} };
    },
    persistBatch: async (entries) => {
      persisted.push(...entries.map((entry) => entry.connectionId));
    },
    onProgress: (event) => events.push(event),
    batchSize: 10,
  });

  assert.deepEqual(persisted, ["ok"]);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.deepEqual(events, [
    { connectionId: "bad", provider: "alpha", status: "failed", error: "provider request failed" },
    {
      connectionId: "ok",
      provider: "alpha",
      status: "succeeded",
      cache: { fetchedAt: "2026-07-20T00:00:00.000Z", quotas: {} },
    },
  ]);
});

test("single-flight joins duplicate refreshes and releases the key after settlement", async () => {
  const singleFlight = createProviderLimitsSingleFlight<string>();
  const deferred = Promise.withResolvers<string>();
  let calls = 0;
  const factory = () => {
    calls += 1;
    return deferred.promise;
  };

  const first = singleFlight.run("same-connection", factory);
  const second = singleFlight.run("same-connection", factory);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);

  deferred.resolve("done");
  assert.equal(await first, "done");

  const third = singleFlight.run("same-connection", async () => {
    calls += 1;
    return "again";
  });
  assert.equal(await third, "again");
  assert.equal(calls, 2);
});
