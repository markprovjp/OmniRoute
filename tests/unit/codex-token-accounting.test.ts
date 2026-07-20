import test from "node:test";
import assert from "node:assert/strict";

const { extractUsageFromResponse } = await import("../../open-sse/handlers/usageExtractor.ts");
const {
  getLoggedInputTokens,
  getLoggedOutputTokens,
  getNonCachedInputTokens,
  getQuotaTokenTotal,
  getPromptCacheReadTokens,
  formatUsageLog,
} = await import("../../src/lib/usage/tokenAccounting.ts");
const { openaiResponsesToOpenAIResponse } =
  await import("../../open-sse/translator/response/openai-responses.ts");

const CODEX_USAGE = {
  input_tokens: 3_514_237,
  output_tokens: 18_232,
  input_tokens_details: {
    cached_tokens: 3_393_792,
  },
};

test("Codex Responses usage separates cached input from quota tokens", () => {
  const usage = extractUsageFromResponse({ response: { usage: CODEX_USAGE } }, "codex");

  assert.deepEqual(usage, {
    prompt_tokens: 3_514_237,
    completion_tokens: 18_232,
    cached_tokens: 3_393_792,
    cache_read_input_tokens: undefined,
    cache_creation_input_tokens: undefined,
    reasoning_tokens: undefined,
  });
  assert.equal(getLoggedInputTokens(usage), 3_514_237);
  assert.equal(getPromptCacheReadTokens(usage), 3_393_792);
  assert.equal(getNonCachedInputTokens(usage), 120_445);
  assert.equal(getLoggedOutputTokens(usage), 18_232);
  assert.equal(getQuotaTokenTotal(usage), 138_677);
  assert.equal(formatUsageLog(usage), "in=120445 | out=18232 | CR=3393792");
});

test("Responses to Chat Completions does not add cached input twice", () => {
  const state = {};
  const translated = openaiResponsesToOpenAIResponse(
    {
      type: "response.completed",
      response: { usage: CODEX_USAGE },
    },
    state
  );

  assert.equal(translated?.usage?.prompt_tokens, 3_514_237);
  assert.equal(translated?.usage?.completion_tokens, 18_232);
  assert.equal(translated?.usage?.total_tokens, 3_532_469);
  assert.equal(translated?.usage?.prompt_tokens_details?.cached_tokens, 3_393_792);
});
