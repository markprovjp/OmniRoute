import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE,
  __clearCodexSyntheticConcurrencyForTesting,
  buildCodexSyntheticConcurrencyKey,
  createCodexSyntheticConcurrencyGuard,
  runWithCodexSyntheticConcurrency,
} from "../../open-sse/services/syntheticCodexConcurrency.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Codex synthetic concurrency key is limited to authenticated non-streaming synthetic sessions", () => {
  const base = {
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "input:sha256:same-prefix",
    stream: false,
  };

  assert.equal(buildCodexSyntheticConcurrencyKey(base), "key-1:input:sha256:same-prefix");
  assert.equal(buildCodexSyntheticConcurrencyKey({ ...base, provider: "openai" }), null);
  assert.equal(buildCodexSyntheticConcurrencyKey({ ...base, stream: true }), null);
  assert.equal(
    buildCodexSyntheticConcurrencyKey({ ...base, sessionKey: "header:explicit-session" }),
    null
  );
  assert.equal(buildCodexSyntheticConcurrencyKey({ ...base, apiKeyId: null }), null);
});

test("Codex synthetic concurrency guard caps one repeated synthetic session", () => {
  const guard = createCodexSyntheticConcurrencyGuard({ maxConcurrent: 2 });

  const first = guard.tryAcquire("key-1:input:sha256:same-prefix");
  const second = guard.tryAcquire("key-1:input:sha256:same-prefix");
  const rejected = guard.tryAcquire("key-1:input:sha256:same-prefix");

  assert.ok(first);
  assert.ok(second);
  assert.equal(rejected, null);
  assert.equal(guard.getActiveCount("key-1:input:sha256:same-prefix"), 2);

  first.release();
  const replacement = guard.tryAcquire("key-1:input:sha256:same-prefix");
  assert.ok(replacement);
  assert.equal(guard.getActiveCount("key-1:input:sha256:same-prefix"), 2);

  second.release();
  replacement.release();
  assert.equal(guard.getActiveCount("key-1:input:sha256:same-prefix"), 0);
});

test("Codex synthetic concurrency guard isolates API keys and sessions", () => {
  const guard = createCodexSyntheticConcurrencyGuard({ maxConcurrent: 1 });

  const first = guard.tryAcquire("key-1:input:sha256:session-a");
  const otherSession = guard.tryAcquire("key-1:input:sha256:session-b");
  const otherKey = guard.tryAcquire("key-2:input:sha256:session-a");

  assert.ok(first);
  assert.ok(otherSession);
  assert.ok(otherKey);
  assert.equal(guard.tryAcquire("key-1:input:sha256:session-a"), null);

  first.release();
  otherSession.release();
  otherKey.release();
});

test("Codex synthetic concurrency lease remains held until the full generation completes", async () => {
  __clearCodexSyntheticConcurrencyForTesting();
  const key = "key-1:input:sha256:long-generation";
  const generations = Array.from({ length: 4 }, () => deferred<string>());
  let upstreamInvocations = 0;

  const activeRequests = generations.map((generation) =>
    runWithCodexSyntheticConcurrency(key, async () => {
      upstreamInvocations += 1;
      return generation.promise;
    })
  );
  await Promise.resolve();

  await assert.rejects(
    runWithCodexSyntheticConcurrency(key, async () => {
      upstreamInvocations += 1;
      return "must-not-run";
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE
  );
  assert.equal(upstreamInvocations, 4, "the rejected fifth request must not invoke upstream");

  generations[0].resolve("completed-0");
  assert.equal(await activeRequests[0], "completed-0");

  const replacement = runWithCodexSyntheticConcurrency(key, async () => {
    upstreamInvocations += 1;
    return "replacement-completed";
  });
  assert.equal(await replacement, "replacement-completed");
  assert.equal(upstreamInvocations, 5);

  generations.slice(1).forEach((generation, index) => generation.resolve(`completed-${index + 1}`));
  assert.deepEqual(await Promise.all(activeRequests.slice(1)), [
    "completed-1",
    "completed-2",
    "completed-3",
  ]);
  __clearCodexSyntheticConcurrencyForTesting();
});

test("Codex synthetic concurrency error exposes a stable local-capacity code", async () => {
  const module = await import("../../open-sse/services/syntheticCodexConcurrency.ts");
  const error = new module.CodexSyntheticConcurrencyError(4);

  assert.equal(error.code, CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE);
  assert.equal(error.maxConcurrent, 4);
  assert.match(error.message, /4 concurrent requests/i);
});
