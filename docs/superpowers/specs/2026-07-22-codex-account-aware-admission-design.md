# Codex Account-Aware Admission Design

## Problem

OmniRoute currently pins explicit and `prompt-cache:*` sessions to one Codex connection without considering live request load. Production has 31 active Codex connections, yet a slow cohort used only six connections and repeatedly selected the same affinity connection while it was already executing long requests. The process-wide concurrency fuse then rejected the seventh request with `CODEX_PROCESS_CONCURRENCY_LIMIT` without proving that the eligible account pool was exhausted.

ClipProxyAPI on the same environment completes comparable requests in roughly 13–37 seconds, so OmniRoute must treat account selection and affinity as the primary defect rather than accept multi-minute latency as normal upstream behavior.

## Goals

- Prefer an eligible idle Codex connection before rejecting or queueing a request.
- Preserve the persisted affinity target, but temporarily spill overlapping requests to another account when the affinity account is at capacity.
- Respect API-key `allowedConnections`, forced combo connections, quota policy, model exclusions, cooldowns, and account health.
- Hold account and process leases until the streaming body completes or is cancelled.
- Return local 429 only when every eligible account is saturated or the final process safety fuse is reached.
- Never mark an account unhealthy or trigger quota/fallback poisoning for local capacity pressure.

## Architecture

Add a process-local Codex account-load registry keyed by `connectionId`. The default account capacity is one active request and is configurable through `CODEX_ACCOUNT_MAX_CONCURRENCY`; an explicit connection `maxConcurrent` value overrides the default.

Credential selection reads the registry. For normal selection it sorts Codex candidates by active load before existing routing tie-breakers. For session affinity, an idle affinity target remains preferred. If that target is saturated, selection temporarily chooses the least-loaded eligible peer without rewriting the persisted affinity mapping.

Immediately before upstream execution, chatCore atomically acquires the selected connection lease. A race that selects an account just before it becomes full produces `codex_account_concurrency`; the outer credential loop excludes that account and retries another eligible account. The lease remains active through full body consumption and cancellation.

The process-wide guard remains only as a final safety fuse. Its default must no longer reject ordinary traffic at six while dozens of accounts are idle; account-level admission becomes the primary control.

## Error Handling

- `CODEX_ACCOUNT_CONCURRENCY_LIMIT`: local selected-account race/capacity signal; retry another eligible account.
- `CODEX_SYNTHETIC_SESSION_CONCURRENCY_LIMIT`: duplicate synthetic-session protection; fail fast as before.
- `CODEX_PROCESS_CONCURRENCY_LIMIT`: final process safety signal only; do not mark accounts unhealthy or fan out blindly.
- When all allowed/healthy accounts are saturated, return a stable local 429 without account health mutation.

## Verification

- An overlapping `prompt-cache:*` request spills from a busy affinity account to an idle account.
- Persisted affinity remains unchanged after temporary spillover.
- With six busy accounts and additional eligible accounts, the next request selects an idle account and does not return process 429.
- Allowed/forced connection constraints remain enforced.
- Streaming completion and cancellation release account capacity.
- Existing synthetic-session, quota, cooldown, failover, and non-Codex tests remain green.
