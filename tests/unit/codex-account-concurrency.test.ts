import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const module = await import("../../open-sse/services/codexAccountConcurrency.ts");

const {
  CodexAccountConcurrencyError,
  createCodexAccountConcurrencyRegistry,
  holdCodexAccountConcurrencyUntilResponseBodyCompletes,
} = module;

test("Codex account concurrency isolates active counts per connection", () => {
  const registry = createCodexAccountConcurrencyRegistry({ defaultMaxConcurrent: 1 });
  const accountA = registry.tryAcquire("account-a");
  const accountB = registry.tryAcquire("account-b");
  assert.ok(accountA);
  assert.ok(accountB);
  assert.equal(registry.getActiveCount("account-a"), 1);
  assert.equal(registry.getActiveCount("account-b"), 1);
  assert.equal(registry.isAtCapacity("account-a"), true);
  assert.equal(registry.tryAcquire("account-a"), null);
  accountA.release();
  assert.equal(registry.isAtCapacity("account-a"), false);
});

test("Codex account concurrency honors a per-connection capacity override", () => {
  const registry = createCodexAccountConcurrencyRegistry({ defaultMaxConcurrent: 1 });
  assert.ok(registry.tryAcquire("account-a", 2));
  assert.ok(registry.tryAcquire("account-a", 2));
  assert.equal(registry.getActiveCount("account-a"), 2);
  assert.equal(registry.tryAcquire("account-a", 2), null);
});

test("Codex account concurrency release is idempotent", () => {
  const registry = createCodexAccountConcurrencyRegistry({ defaultMaxConcurrent: 1 });
  const lease = registry.tryAcquire("account-a");
  assert.ok(lease);
  lease.release();
  lease.release();
  assert.equal(registry.getActiveCount("account-a"), 0);
});

test("Codex account concurrency error exposes a stable retryable code", () => {
  const error = new CodexAccountConcurrencyError("account-a", 1);
  assert.equal(error.name, "CodexAccountConcurrencyError");
  assert.equal(error.code, "CODEX_ACCOUNT_CONCURRENCY_LIMIT");
  assert.equal(error.connectionId, "account-a");
  assert.equal(error.maxConcurrent, 1);
});

test("Codex account lease remains held until a streaming body completes", async () => {
  const registry = createCodexAccountConcurrencyRegistry({ defaultMaxConcurrent: 1 });
  const lease = registry.tryAcquire("account-a");
  assert.ok(lease);

  let finish!: () => void;
  const waitForFinish = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("first"));
      await waitForFinish;
      controller.enqueue(encoder.encode("second"));
      controller.close();
    },
  });

  const wrapped = holdCodexAccountConcurrencyUntilResponseBodyCompletes(
    new Response(source),
    lease
  );
  const reader = wrapped.body!.getReader();
  const firstChunk = await reader.read();
  assert.equal(new TextDecoder().decode(firstChunk.value), "first");
  assert.equal(registry.isAtCapacity("account-a"), true);
  finish();
  while (!(await reader.read()).done) {
    // Drain the response so the lease finalizer runs.
  }
  assert.equal(registry.isAtCapacity("account-a"), false);
});

test("Codex account lease releases when the streaming body is cancelled", async () => {
  const registry = createCodexAccountConcurrencyRegistry({ defaultMaxConcurrent: 1 });
  const lease = registry.tryAcquire("account-a");
  assert.ok(lease);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("open"));
    },
  });
  const wrapped = holdCodexAccountConcurrencyUntilResponseBodyCompletes(
    new Response(source),
    lease
  );
  const reader = wrapped.body!.getReader();
  await reader.read();
  assert.equal(registry.isAtCapacity("account-a"), true);
  await reader.cancel("client disconnected");
  assert.equal(registry.isAtCapacity("account-a"), false);
});

test("chatCore acquires and holds the selected Codex account lease", () => {
  const chatCore = fs.readFileSync(
    new URL("../../open-sse/handlers/chatCore.ts", import.meta.url),
    "utf8"
  );
  assert.match(chatCore, /acquireCodexAccountConcurrency\(/);
  assert.match(chatCore, /holdCodexAccountConcurrencyUntilResponseBodyCompletes\(/);
  assert.match(chatCore, /isCodexAccountConcurrencyError\(error\)/);
  assert.match(chatCore, /codex_account_concurrency/);
  assert.match(
    chatCore,
    /switchCodexAccountLease\(nextCreds\)[\s\S]*Object\.assign\(credentials, nextCreds\)/
  );
});

test("outer chat handler retries another account for local Codex account capacity", () => {
  const chatHandler = fs.readFileSync(
    new URL("../../src/sse/handlers/chat.ts", import.meta.url),
    "utf8"
  );
  assert.match(chatHandler, /result\.errorType === "codex_account_concurrency"/);
  assert.match(chatHandler, /excludedConnectionIds\.add\(credentials\.connectionId\)/);
  assert.match(chatHandler, /trying another eligible account/);
});
