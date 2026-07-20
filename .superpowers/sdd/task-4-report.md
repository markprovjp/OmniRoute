# Task 4 Report: Customer Usage Telegram Link

## RED

- Added `tests/unit/customer-usage-telegram-link.test.ts` as a source-contract test for the
  customer usage Telegram alert action.
- Ran `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests\unit\customer-usage-telegram-link.test.ts`.
- Result: 0 passed, 1 failed. The expected `/api/customer/telegram-link` action was absent.

## GREEN

- Added one compact Telegram alert card to `src/app/usage/CustomerUsagePageClient.tsx`, rendered
  only after usage lookup succeeds.
- The action posts the trimmed current key only to `/api/customer/telegram-link`, blocks duplicate
  clicks while loading, accepts only `https://t.me/qrouter_token_bot?start=` deep links, and never
  renders the API key as a link or visible value.
- Added default, hover, focus-visible, active, disabled/loading, error, and success states using
  existing Tailwind utilities and palette classes.

## Files

- `src/app/usage/CustomerUsagePageClient.tsx`
- `tests/unit/customer-usage-telegram-link.test.ts`

## Verification

- `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests\unit\customer-usage-telegram-link.test.ts`
  - RED: 0 passed, 1 failed.
  - GREEN: 1 passed, 0 failed.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\prettier\bin\prettier.cjs --write src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.ts`
  - Passed; both files unchanged after the prior format pass.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\eslint\bin\eslint.js src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.ts`
  - Passed with no output.
- React Doctor project detection found the root Next.js project; diff scan completed with 0 errors
  and 1 pre-existing warning in `src/lib/usage/apiKeyAlerts.ts:223`.
- `git diff --cached --check`
  - Passed before commit.

## Commit

- `641c9dccf589f645bcf0977dba26b400ca398389` - `feat(usage): add secure Telegram alert linking`

## Self-Review

- The returned link is validated against the exact approved prefix before `window.open`.
- Non-OK and malformed responses share the generic error state.
- The raw API key is only used in the POST body and remains in the password input; no key-derived
  `href` or display was added.
- The card preserves the existing Inter/font, color tokens, spacing, light/dark colors, alert-card
  placement, responsive layout, and motion-cut approach.

## Concerns

- React Doctor's single warning is outside this task. The commit hook also reports pre-existing
  repository-wide UI i18n coverage below its 80% threshold, but the commit completed successfully.

## Review Remediation

- The Telegram claim action now retains the exact trimmed key from the successful usage lookup and
  clears usage, logs, Telegram state, and that bound key when the input changes. A stale lookup
  response is ignored, so a displayed usage result cannot be associated with an edited key.
- The asynchronous POST no longer opens a popup or reports a completed connection. After exact
  `https://t.me/qrouter_token_bot?start=` validation, it renders a real `noopener noreferrer`
  Telegram anchor that the customer activates to finish the connection.

## Focused Verification

- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\vitest\vitest.mjs run tests\unit\customer-usage-telegram-link.test.tsx --reporter=verbose`
  - Passed: 3/3 tests covering key-edit invalidation, malformed-prefix rejection, and the
    validated user-activated Telegram deep-link state.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\prettier\bin\prettier.cjs --write src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.tsx`
  - Passed; both files are formatted.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\eslint\bin\eslint.js src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.tsx`
  - Passed with no output.
- React Doctor detected the root Next.js project and scanned the branch diff with 0 errors and 0 warnings.

## Review Self-Review

- The POST body uses only the key that produced the displayed usage; editing the input hides the
  action before another claim can be issued.
- Only an exact approved Telegram prefix may become an anchor `href`; the raw key is absent from
  the rendered URL and remains masked in the input.
- The anchor is intentionally user-activated, avoiding unreliable asynchronous popup behavior;
  success wording is deferred until the customer can open Telegram to finish connecting.

## Remediation Commit

- `b573a83e5` - `fix(usage): bind Telegram link to checked key`

## Final Gate Remediation

- Telegram claim responses now capture a request generation and the exact checked key. Input edits
  and every new usage lookup invalidate that generation; after each Telegram response await, the
  UI writes ready/error state only when both the generation and checked-key identity still match.
- Added focused coverage for a deferred A claim resolved after editing and checking B, a non-OK
  claim response, and duplicate clicks while the first claim is pending. The stale A response
  cannot render an anchor under B.

## Final Gate Verification

- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\vitest\vitest.mjs run tests\unit\customer-usage-telegram-link.test.tsx --reporter=verbose`
  - Passed: 1 test file and 6 tests.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\prettier\bin\prettier.cjs --write src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.tsx .superpowers\sdd\task-4-report.md`
  - Passed; all three files were unchanged.
- `D:\tools\node-v24.15.0-win-x64\node.exe node_modules\eslint\bin\eslint.js src\app\usage\CustomerUsagePageClient.tsx tests\unit\customer-usage-telegram-link.test.tsx`
  - Passed with no output.
- React Doctor detected the root Next.js project. Its branch-diff scan reported 0 errors and 2
  warnings: the existing component's many coordinated state updates (`prefer-useReducer`) and an
  unrelated sequential await in `src/lib/usage/apiKeyAlerts.ts`.
- `git diff --check`
  - Passed.

## Final Gate Commit

- `fix(usage): ignore stale Telegram claims`

## Final Gate Self-Review

- The safe, user-activated `noopener noreferrer` anchor remains gated by the exact approved
  Telegram prefix, and the raw customer key is only present in the POST body.
- A claim response cannot set ready, error, or deep-link state after its key was edited or any new
  lookup started, including a successful lookup for a different key.
