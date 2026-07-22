import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rate-limit-queue-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("rate-limit queue timeout does not kill an already-running stream", async () => {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    requestsPerMinute: 1000,
    minTimeBetweenRequestsMs: 0,
    concurrentRequests: 1,
    maxWaitMs: 25,
  });
  rateLimitManager.enableRateLimitProtection("queue-timeout-connection");

  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const first = rateLimitManager.withRateLimit(
    "codex",
    "queue-timeout-connection",
    "gpt-5.6-sol",
    async () => {
      markStarted();
      await firstReleased;
      return "first";
    }
  );

  await firstStarted;

  await assert.rejects(
    rateLimitManager.withRateLimit(
      "codex",
      "queue-timeout-connection",
      "gpt-5.6-sol",
      async () => "second"
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "RateLimitQueueTimeoutError");
      assert.equal((error as Error & { code?: string }).code, "RATE_LIMIT_QUEUE_TIMEOUT");
      assert.equal((error as Error & { maxWaitMs?: number }).maxWaitMs, 25);
      return true;
    }
  );

  releaseFirst();
  assert.equal(await first, "first");
});

test("chat pipeline returns local queue pressure without poisoning account fallback", () => {
  const chatCore = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  const chatHandler = fs.readFileSync("src/sse/handlers/chat.ts", "utf8");

  assert.match(chatCore, /isRateLimitQueueTimeoutError\(error\)/);
  assert.match(chatCore, /errorType:\s*"rate_limit_queue_timeout"/);
  assert.match(chatHandler, /result\.errorType === "rate_limit_queue_timeout"/);
});
