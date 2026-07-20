# Codex OAuth + QRouter reasoning effort investigation

Date: 2026-07-19

## Conclusion

`max` and `xhigh` are valid values in the public OpenAI API schema, but the
current QRouter `cx/gpt-5.6-sol` OAuth route does not accept them. The working
value observed through that route is `high`. This is an upstream capability or
entitlement mismatch, not evidence that the local Codex TOML syntax is wrong.

Changing OmniRoute to pass `max` unchanged would not unlock the feature: the
current route rejects both `max` and `xhigh` before generation.

## Reproduction evidence

The live QRouter `/v1/responses` probes for `cx/gpt-5.6-sol` were run with the
user's token without recording it here:

| Request field                         | Result                          |
| ------------------------------------- | ------------------------------- |
| `reasoning: { effort: "high" }`       | HTTP 200                        |
| `reasoning: { effort: "xhigh" }`      | HTTP 400                        |
| `reasoning: { effort: "max" }`        | HTTP 400                        |
| top-level `reasoning_effort: "xhigh"` | HTTP 400, unsupported parameter |
| top-level `reasoning_effort: "max"`   | HTTP 400, unsupported parameter |

The live `/v1/models` record advertises `reasoning: true`, but does not list
supported effort levels. It reports `api_format: responses`, context length
400000, and max output tokens 8192.

## Local request path

Before the 2026-07-19 local compatibility patch, OmniRoute's Codex executor
defined the effort order only through `xhigh` and normalized an incoming `max`
to `xhigh` before sending the request:

- [`open-sse/executors/codex.ts`](../../open-sse/executors/codex.ts) lines 253-254,
  759-763, and 1434-1440.
- The old regression test explicitly asserted `max` became
  `reasoning.effort = "xhigh"` in
  [`tests/unit/executor-codex.test.ts`](../../tests/unit/executor-codex.test.ts).

The local patch now registers `gpt-5.6-sol` in the Codex provider catalog,
preserves `xhigh`, and sends `max` as the first-class wire value `max`. Targeted
unit tests prove those local transformation and sanitation seams. This only
removes OmniRoute-side downgrading; it does not change the OAuth backend's
observed HTTP 400 response.

The `cx` provider is OAuth-backed and targets
`https://chatgpt.com/backend-api/codex/responses`, as registered in
[`open-sse/config/providerRegistry.ts`](../../open-sse/config/providerRegistry.ts).
That is a different service surface from the public OpenAI Platform API.

## First-party source findings

OpenAI API documentation lists `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max` as reasoning-effort values, while explicitly warning that
not every reasoning model supports every value:

- [Create chat completion API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

The current Codex manual makes the same distinction: `max` and `xhigh` are
usable when the selected model supports them, while `ultra` is conditional on
model support. The manual therefore does not turn a rejected provider request
into a client configuration bug.

The official Codex change [PR #30467](https://github.com/openai/codex/pull/30467),
merged 2026-06-29, is titled “Treat max as a first-class reasoning effort.” Its
description says the motivation was the **Bedrock GPT-5.6 catalog**, and the
change maps Codex's `Ultra` preset to the typed `Max` value while preserving the
wire value `max`. This is client/catalog support for the Bedrock path; it does
not assert that the ChatGPT Codex OAuth backend accepts `max` for every model.

The official Codex model catalog at tags `rust-v0.144.1` and `rust-v0.144.6`
advertises `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` for
`gpt-5.6-sol`. That metadata proves the client can expose the options; it does
not override a rejecting upstream request.

## Recommended action

Keep the current production QRouter configuration at
`model_reasoning_effort = "high"` until QRouter confirms and enables
`xhigh`/`max` on the OAuth `cx` route. The local pass-through patch is suitable
for compatibility testing, but deploying it now would expose the upstream
rejection instead of unlocking a higher reasoning tier.

A Codex client upgrade is reasonable as a separately tested experiment, but
the available 0.144.x source/release evidence does not establish that an
upgrade changes the ChatGPT OAuth backend entitlement. The decisive test is a
fresh QRouter request that returns HTTP 200 for nested `reasoning.effort =
"xhigh"` or `"max"`.
