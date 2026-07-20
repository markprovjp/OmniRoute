# Task 5 Report: Telegram Commands And Long-Polling Runtime

## RED

- Added `tests/unit/telegram-token-bot.test.ts` before the bot modules existed.
- Ran Node 24 with `--import tsx/esm --test`; it failed with `ERR_MODULE_NOT_FOUND` for
  `src/lib/telegramTokenBot/bot.ts`.

## GREEN

- Added a grammY private-chat command bot with `/start`, `/status`, `/usage`, `/alerts`,
  `/mute`, `/unmute`, `/disconnect`, and `/help`.
- Uses a fake Telegram Bot API in the handler tests, HTML-escapes all displayed DB-derived text,
  never displays a raw API key, accepts only fixed callback data, and keeps group chats silent.
- Enforces six commands per minute per private chat and five invalid claims per chat in fifteen
  minutes. Invalid claims have one generic response.
- Added guarded runner startup: token from `QROUTER_TELEGRAM_BOT_TOKEN`, `getMe` username check,
  webhook inspection with explicit deletion opt-in, singleton lease/cursor persistence, command
  registration, sequential `@grammyjs/runner` polling, and awaited signal shutdown.

## Tests

- RED: `D:\tools\node-v24.15.0-win-x64\node.exe --import tsx/esm --test tests\unit\telegram-token-bot.test.ts`
  - Failed as expected: bot module did not exist.
- GREEN: the same Node 24 command passed `4/4` tests.
- Reuse lane: Node 24 ran `telegram-token-bot`, `telegram-bot-db`, and
  `api-key-customer-usage` sequentially: `16/16` passed.
- Focused ESLint with `--no-ignore` passed for all Task 5 TypeScript files.
- `typecheck:core` still reports unrelated pre-existing errors in `open-sse` and embeddings;
  its output contained no Task 5 file errors.

## Dependency Review

- Installed only the requested runtime packages through
  `D:\tools\node-v24.15.0-win-x64\npm.cmd`: `grammy@1.45.1`,
  `@grammyjs/runner@2.0.3`, and `@grammyjs/ratelimiter@1.2.1`.
- The lockfile pins integrity hashes. All three packages are MIT-licensed.
- The install audit reported 14 repository dependency vulnerabilities (3 low, 3 moderate,
  6 high, 2 critical); no audit fix was applied because it would exceed Task 5 scope.

## Commit

- `feat(telegram): add secure customer usage bot`

## Self-Review

- No source logging emits bot tokens, customer messages, or usernames. The entrypoint emits only
  a generic startup failure string.
- A configured webhook blocks polling unless deletion is explicitly enabled; webhook URLs are not
  logged. The runner processes updates sequentially before advancing the durable cursor.
- The command throttle does not consume callback events, and the disconnect action requires an
  explicit fixed confirmation callback.
- The existing dirty `.env.example` changes are preserved; only the Task 5 environment block is
  staged for this commit.

## Concerns

- No live Telegram Bot API call was made because no bot token was supplied for this task.
- Repository-wide core typecheck is currently red outside Task 5, and the dependency audit has
  pre-existing findings that need a separate remediation task.
