import { createTelegramLinkClaim } from "@/lib/db/telegramBot";

const DEFAULT_TELEGRAM_BOT_USERNAME = "qrouter_token_bot";
const TELEGRAM_BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

function getTelegramBotUsername(): string {
  const configured = process.env.QROUTER_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return configured && TELEGRAM_BOT_USERNAME_PATTERN.test(configured)
    ? configured
    : DEFAULT_TELEGRAM_BOT_USERNAME;
}

export function issueTelegramLinkClaim(apiKeyId: string, now?: Date) {
  const claim = createTelegramLinkClaim(apiKeyId, now);

  return {
    deepLink: `https://t.me/${getTelegramBotUsername()}?start=${claim.token}`,
    expiresAt: claim.expiresAt,
  };
}
