import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { runProviderLimitsRefreshPool } from "../../src/lib/usage/providerLimitsRefreshPool.ts";

interface TestConnection {
  id: string;
  provider: string;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("provider limits pool is fair, bounded, and work-conserving", async () => {
  const connections: TestConnection[] = [
    { id: "a-1", provider: "alpha" },
    { id: "a-2", provider: "alpha" },
    { id: "a-3", provider: "alpha" },
    { id: "b-1", provider: "beta" },
    { id: "b-2", provider: "beta" },
    { id: "b-3", provider: "beta" },
  ];
  const gates = new Map(
    connections.map((connection) => [connection.id, Promise.withResolvers<string>()])
  );
  const started: string[] = [];
  const settled: string[] = [];

  const run = runProviderLimitsRefreshPool(
    connections,
    async (connection) => {
      started.push(connection.id);
      return gates.get(connection.id)!.promise;
    },
    {
      globalConcurrency: 3,
      perProviderConcurrency: 2,
      onSettled: (connection) => {
        settled.push(connection.id);
      },
    }
  );

  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ["a-1", "b-1", "a-2"]);

  gates.get("a-1")!.resolve("a-1");
  await waitFor(() => started.length === 4);
  assert.equal(started[3], "b-2", "a free slot should not wait for the slow initial batch");
  assert.equal(settled.includes("a-1"), true);

  for (const gate of gates.values()) gate.resolve("done");
  const summary = await run;

  assert.equal(summary.total, connections.length);
  assert.equal(summary.succeeded, connections.length);
  assert.equal(summary.failed, 0);
  assert.ok(summary.peakGlobalConcurrency <= 3);
  assert.ok(summary.peakProviderConcurrency.alpha <= 2);
  assert.ok(summary.peakProviderConcurrency.beta <= 2);
});

test("provider limits pool uses indexed queues instead of quadratic Array.shift", () => {
  const source = fs.readFileSync(
    new URL("../../src/lib/usage/providerLimitsRefreshPool.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /\.shift\s*\(/);
});

test("provider limits pool keeps active work bounded for 10,000 accounts", async () => {
  const connections = Array.from({ length: 10_000 }, (_, index) => ({
    id: `connection-${index}`,
    provider: `provider-${index % 10}`,
  }));

  const summary = await runProviderLimitsRefreshPool(
    connections,
    async (connection) => connection.id,
    { globalConcurrency: 32, perProviderConcurrency: 8 }
  );

  assert.equal(summary.total, 10_000);
  assert.equal(summary.succeeded, 10_000);
  assert.equal(summary.failed, 0);
  assert.ok(summary.peakGlobalConcurrency <= 32);
  for (const peak of Object.values(summary.peakProviderConcurrency)) {
    assert.ok(peak <= 8);
  }
});
