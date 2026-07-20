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
