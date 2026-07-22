import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE,
  __clearCodexSyntheticConcurrencyForTesting,
  buildCodexSyntheticConcurrencyKey,
  createCodexRequestConcurrencyController,
  createCodexSyntheticConcurrencyGuard,
  getCodexApiKeyMaxConcurrent,
  getCodexProcessMaxConcurrent,
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

test("Codex default request fuses leave room for account-aware spillover", () => {
  const originalApiKeyLimit = process.env.CODEX_API_KEY_MAX_CONCURRENCY;
  const originalProcessLimit = process.env.CODEX_PROCESS_MAX_CONCURRENCY;
  delete process.env.CODEX_API_KEY_MAX_CONCURRENCY;
  delete process.env.CODEX_PROCESS_MAX_CONCURRENCY;

  try {
    assert.ok(
      getCodexApiKeyMaxConcurrent() >= 32,
      "the default API-key fuse must not reject while a large account pool is idle"
    );
    assert.ok(
      getCodexProcessMaxConcurrent() >= 32,
      "the default process fuse must remain an emergency ceiling after account routing"
    );
  } finally {
    if (originalApiKeyLimit === undefined) delete process.env.CODEX_API_KEY_MAX_CONCURRENCY;
    else process.env.CODEX_API_KEY_MAX_CONCURRENCY = originalApiKeyLimit;
    if (originalProcessLimit === undefined) delete process.env.CODEX_PROCESS_MAX_CONCURRENCY;
    else process.env.CODEX_PROCESS_MAX_CONCURRENCY = originalProcessLimit;
  }
});

test("Codex request concurrency caps aggregate work per authenticated API key", () => {
  const controller = createCodexRequestConcurrencyController({
    processMaxConcurrent: 8,
    apiKeyMaxConcurrent: 2,
    syntheticMaxConcurrent: 4,
  });

  const first = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "prompt-cache:session-a",
    stream: true,
  });
  const second = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "prompt-cache:session-b",
    stream: true,
  });

  assert.throws(
    () =>
      controller.acquire({
        provider: "codex",
        apiKeyId: "key-1",
        sessionKey: "prompt-cache:session-c",
        stream: true,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "CODEX_API_KEY_CONCURRENCY_LIMIT"
  );

  const otherKey = controller.acquire({
    provider: "codex",
    apiKeyId: "key-2",
    sessionKey: "prompt-cache:session-c",
    stream: true,
  });
  assert.equal(controller.getProcessActiveCount(), 3);
  assert.equal(controller.getApiKeyActiveCount("key-1"), 2);
  assert.equal(controller.getApiKeyActiveCount("key-2"), 1);

  first.release();
  second.release();
  otherKey.release();
});

test("Codex request concurrency keeps explicit, prompt-cache, and streaming sessions isolated from the synthetic-session cap", () => {
  const controller = createCodexRequestConcurrencyController({
    processMaxConcurrent: 8,
    apiKeyMaxConcurrent: 6,
    syntheticMaxConcurrent: 1,
  });

  const explicit = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "header:explicit-session",
    stream: false,
  });
  const promptCache = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "prompt-cache:session-a",
    stream: false,
  });
  const streaming = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "input:sha256:shared-prefix",
    stream: true,
  });
  const synthetic = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "input:sha256:shared-prefix",
    stream: false,
  });

  assert.throws(
    () =>
      controller.acquire({
        provider: "codex",
        apiKeyId: "key-1",
        sessionKey: "input:sha256:shared-prefix",
        stream: false,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE
  );

  explicit.release();
  promptCache.release();
  streaming.release();
  synthetic.release();
});

test("Codex request concurrency applies a process safety fuse without creating an anonymous API-key bucket", () => {
  const controller = createCodexRequestConcurrencyController({
    processMaxConcurrent: 2,
    apiKeyMaxConcurrent: 1,
    syntheticMaxConcurrent: 1,
  });

  const anonymousOne = controller.acquire({
    provider: "codex",
    apiKeyId: null,
    sessionKey: "input:sha256:session-a",
    stream: false,
  });
  const anonymousTwo = controller.acquire({
    provider: "codex",
    apiKeyId: null,
    sessionKey: "input:sha256:session-b",
    stream: false,
  });

  assert.equal(controller.getApiKeyActiveCount("anonymous"), 0);
  assert.throws(
    () =>
      controller.acquire({
        provider: "codex",
        apiKeyId: null,
        sessionKey: "input:sha256:session-c",
        stream: false,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "CODEX_PROCESS_CONCURRENCY_LIMIT"
  );

  anonymousOne.release();
  anonymousTwo.release();
});

test("Codex aggregate concurrency pressure returns locally without account fallback", () => {
  const chatCore = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  const chatHandler = fs.readFileSync("src/sse/handlers/chat.ts", "utf8");

  assert.match(chatCore, /acquireCodexRequestConcurrency\(/);
  assert.match(chatCore, /holdCodexConcurrencyUntilResponseBodyCompletes\(/);
  assert.match(chatCore, /isCodexRequestConcurrencyError\(error\)/);
  assert.match(chatCore, /errorType = .*"codex_concurrency"/s);
  assert.match(chatHandler, /result\.errorType === "codex_concurrency"/);
});
