import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderLimitsRefreshJobCoordinator,
  type ProviderLimitsRefreshJobRunner,
} from "../../src/lib/usage/providerLimitsRefreshJobs.ts";
import type { ProviderLimitsRefreshEvent } from "../../src/lib/usage/providerLimitsRefreshEngine.ts";
import type { ProviderLimitsCacheEntry } from "../../src/lib/db/providerLimits.ts";

const CACHE: ProviderLimitsCacheEntry = {
  quotas: { session: { used: 1, total: 10 } },
  plan: "plus",
  message: null,
  fetchedAt: "2026-07-20T00:00:00.000Z",
  source: "manual",
};

test("refresh job starts immediately, deduplicates, and returns cursor deltas", async () => {
  const completion = Promise.withResolvers<void>();
  let emit:
    | ((event: ProviderLimitsRefreshEvent<ProviderLimitsCacheEntry>) => Promise<void>)
    | null = null;
  let runnerCalls = 0;

  const runner: ProviderLimitsRefreshJobRunner = async (options) => {
    runnerCalls += 1;
    await options.onStart?.(3);
    emit = async (event) => {
      await options.onProgress?.(event);
    };
    await emit({ connectionId: "a", provider: "codex", status: "succeeded", cache: CACHE });
    await completion.promise;
    return {
      total: 3,
      succeeded: 2,
      failed: 1,
      caches: {},
      errors: {},
      peakGlobalConcurrency: 2,
      peakProviderConcurrency: { codex: 2 },
      batchFlushes: 1,
    };
  };

  const coordinator = createProviderLimitsRefreshJobCoordinator({
    runSync: runner,
    idFactory: () => "job-1",
    now: () => Date.parse("2026-07-20T00:00:00.000Z"),
  });

  const first = await coordinator.start("manual");
  assert.equal(first.job.state, "running");
  assert.equal(first.job.total, 3);
  assert.equal(first.job.completed, 1);
  assert.equal(first.deduplicated, false);

  const second = await coordinator.start("manual");
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.deduplicated, true);
  assert.equal(runnerCalls, 1);

  const initial = coordinator.get("job-1", 0);
  assert.equal(initial?.updates.length, 1);
  assert.equal(initial?.updates[0].sequence, 1);
  assert.equal(initial?.job.cursor, 1);
  assert.equal(coordinator.get("job-1", 1)?.updates.length, 0);

  await emit?.({
    connectionId: "b",
    provider: "claude",
    status: "failed",
    error: "quota unavailable",
  });
  const delta = coordinator.get("job-1", 1);
  assert.deepEqual(
    delta?.updates.map((update) => update.sequence),
    [2]
  );
  assert.equal(delta?.job.completed, 2);
  assert.equal(delta?.job.failed, 1);

  completion.resolve();
  const completed = await coordinator.wait("job-1");
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.completed, 3);
  assert.equal(completed?.succeeded, 2);
  assert.equal(completed?.failed, 1);
});

test("default refresh coordinator survives duplicate route-module evaluation", async () => {
  const moduleUrl = new URL("../../src/lib/usage/providerLimitsRefreshJobs.ts", import.meta.url)
    .href;
  const first = await import(`${moduleUrl}?route=collection`);
  const second = await import(`${moduleUrl}?route=dynamic`);

  assert.strictEqual(first.providerLimitsRefreshJobs, second.providerLimitsRefreshJobs);
});

test("completed refresh jobs expire after the configured TTL", async () => {
  let now = 1_000;
  const runner: ProviderLimitsRefreshJobRunner = async (options) => {
    await options.onStart?.(0);
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      caches: {},
      errors: {},
      peakGlobalConcurrency: 0,
      peakProviderConcurrency: {},
      batchFlushes: 0,
    };
  };
  const coordinator = createProviderLimitsRefreshJobCoordinator({
    runSync: runner,
    idFactory: () => "expiring-job",
    now: () => now,
    jobTtlMs: 500,
  });

  await coordinator.start("manual");
  await coordinator.wait("expiring-job");
  assert.ok(coordinator.get("expiring-job", 0));

  now += 501;
  assert.equal(coordinator.get("expiring-job", 0), null);
  assert.equal(coordinator.getActive(), null);
});
