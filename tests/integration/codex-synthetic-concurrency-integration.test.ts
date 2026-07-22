import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE,
  __clearCodexSyntheticConcurrencyForTesting,
  createCodexRequestConcurrencyController,
  holdCodexConcurrencyUntilResponseBodyCompletes,
  runWithCodexSyntheticConcurrency,
} from "../../open-sse/services/syntheticCodexConcurrency.ts";

const encoder = new TextEncoder();

function createControlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );

  return {
    response,
    complete(value: string) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  };
}

test.beforeEach(() => {
  __clearCodexSyntheticConcurrencyForTesting();
});

test.after(() => {
  __clearCodexSyntheticConcurrencyForTesting();
});

test("aggregate Codex concurrency lease remains held until a streaming response body is drained", async () => {
  const controller = createCodexRequestConcurrencyController({
    processMaxConcurrent: 4,
    apiKeyMaxConcurrent: 1,
    syntheticMaxConcurrent: 4,
  });
  const controlled = createControlledResponse();
  const lease = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "prompt-cache:streaming",
    stream: true,
  });
  const wrapped = holdCodexConcurrencyUntilResponseBodyCompletes(controlled.response, lease);
  const draining = wrapped.text();

  assert.throws(
    () =>
      controller.acquire({
        provider: "codex",
        apiKeyId: "key-1",
        sessionKey: "prompt-cache:another-stream",
        stream: true,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "CODEX_API_KEY_CONCURRENCY_LIMIT"
  );

  controlled.complete("data: first\\n\\n");
  assert.match(await draining, /data: first/);

  const replacement = controller.acquire({
    provider: "codex",
    apiKeyId: "key-1",
    sessionKey: "prompt-cache:replacement",
    stream: true,
  });
  replacement.release();
});

test("a fifth repeated synthetic request is rejected while four full response bodies remain active", async () => {
  const key = "api-key-1:input:sha256:shared-prefix";
  const controlledResponses = Array.from({ length: 5 }, () => createControlledResponse());
  let upstreamInvocations = 0;

  const executeFullGeneration = (response: Response) =>
    runWithCodexSyntheticConcurrency(key, async () => {
      upstreamInvocations += 1;
      return response.text();
    });

  const activeRequests = controlledResponses
    .slice(0, 4)
    .map(({ response }) => executeFullGeneration(response));
  await Promise.resolve();

  await assert.rejects(
    executeFullGeneration(controlledResponses[4].response),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === CODEX_SYNTHETIC_CONCURRENCY_ERROR_CODE
  );
  assert.equal(upstreamInvocations, 4, "the rejected fifth request must not invoke upstream");

  controlledResponses[0].complete("completed-0");
  assert.equal(await activeRequests[0], "completed-0");

  const replacementResponse = createControlledResponse();
  const replacement = executeFullGeneration(replacementResponse.response);
  await Promise.resolve();
  assert.equal(upstreamInvocations, 5, "a completed body must release one concurrency slot");
  replacementResponse.complete("replacement-completed");
  assert.equal(await replacement, "replacement-completed");

  controlledResponses.slice(1, 4).forEach((response, index) => {
    response.complete(`completed-${index + 1}`);
  });
  assert.deepEqual(await Promise.all(activeRequests.slice(1)), [
    "completed-1",
    "completed-2",
    "completed-3",
  ]);
});
