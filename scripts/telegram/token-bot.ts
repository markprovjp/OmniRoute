import { startTelegramTokenBot } from "../../src/lib/telegramTokenBot/runtime.ts";

try {
  await startTelegramTokenBot();
} catch {
  process.stderr.write("Telegram token bot failed to start.\n");
  process.exitCode = 1;
}
