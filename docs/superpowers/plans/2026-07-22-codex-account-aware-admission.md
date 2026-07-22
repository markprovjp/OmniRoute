# Codex Account-Aware Admission Implementation Plan

> **For agentic workers:** Execute inline through the main Pi agent. Use test-first development and verify every slice before continuing.

**Goal:** Route overlapping Codex requests to eligible idle accounts before returning local capacity errors.

**Architecture:** A small process-local registry tracks active requests per Codex connection. Credential selection consults live load while preserving persisted affinity, and chatCore acquires/releases the selected account lease across the full response body lifecycle.

**Tech Stack:** TypeScript 5.9, Node.js 26, Next.js 16, Node test runner.

## Global Constraints

- Respect allowed and forced connection constraints, quota policy, cooldowns, and model exclusions.
- Do not mutate account health for local capacity errors.
- Do not change TPS or duration metric semantics.
- Keep the process guard as a final safety fuse, not the primary account router.

---

### Task 1: Account-load registry

**Files:**
- Create: `open-sse/services/codexAccountConcurrency.ts`
- Test: `tests/unit/codex-account-concurrency.test.ts`

- [ ] Write tests proving per-account isolation, capacity rejection, idempotent release, and stream-body lifecycle release.
- [ ] Run `node --import tsx/esm --test tests/unit/codex-account-concurrency.test.ts` and verify RED.
- [ ] Implement the minimal registry and response-body lease wrapper.
- [ ] Re-run the focused test and verify GREEN.

### Task 2: Load-aware credential selection

**Files:**
- Modify: `src/sse/services/auth.ts`
- Modify: `tests/unit/sse-auth.test.ts`

- [ ] Add tests where a busy prompt-cache affinity target spills to an idle eligible peer without rebinding affinity.
- [ ] Add tests proving allowedConnections and forcedConnectionId still constrain spillover.
- [ ] Run the focused auth tests and verify RED.
- [ ] Sort Codex candidates by live active load and implement temporary affinity spillover.
- [ ] Re-run the focused auth tests and verify GREEN.

### Task 3: Execution lease and race fallback

**Files:**
- Modify: `open-sse/handlers/chatCore.ts`
- Modify: `src/sse/handlers/chat.ts`
- Modify: `tests/integration/codex-synthetic-concurrency-integration.test.ts`

- [ ] Add an integration test proving a selected-account capacity race returns `codex_account_concurrency` and the outer handler retries another account rather than poisoning health.
- [ ] Run the integration test and verify RED.
- [ ] Acquire the account lease immediately before the process/upstream lease and hold it through body completion or cancellation.
- [ ] Map account capacity to a distinct retryable local error type.
- [ ] Re-run focused integration and handler tests and verify GREEN.

### Task 4: Process safety behavior and documentation

**Files:**
- Modify: `open-sse/services/syntheticCodexConcurrency.ts`
- Modify: `.env.example`
- Modify: `docs/reference/ENVIRONMENT.md`
- Modify: relevant concurrency tests

- [ ] Add a test proving ordinary account-aware traffic is not rejected at six by the default process guard.
- [ ] Verify RED.
- [ ] Raise the default process fuse to a conservative emergency ceiling while keeping the environment override.
- [ ] Document `CODEX_ACCOUNT_MAX_CONCURRENCY` and the revised process-fuse role.
- [ ] Verify GREEN.

### Task 5: Verification and deployment

- [ ] Run focused Node 26 unit/integration tests.
- [ ] Run ESLint and Prettier on changed files.
- [ ] Run `git diff --check` and the smallest relevant production build.
- [ ] Review the diff for fallback poisoning, lease leaks, forced-connection violations, and unrelated changes.
- [ ] Commit and push the exact tested SHA.
- [ ] Deploy only through `omniroute-deploy.service`.
- [ ] Verify production uses multiple eligible accounts under overlap, no avoidable process 429 occurs, app/Redis remain healthy, and SQLite `quick_check` is `ok`.
