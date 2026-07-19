import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const COMPONENT_PATH = path.resolve("src/app/usage/CustomerUsagePageClient.tsx");

test("customer usage links Telegram alerts through the fixed safe endpoint", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  assert.match(source, /fetch\("\/api\/customer\/telegram-link",\s*\{/);
  assert.match(source, /method:\s*"POST"/);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*apiKey:\s*key\s*\}\)/);
  assert.match(source, /if\s*\(!response\.ok\)/);
  assert.match(source, /telegramLinkStatus\s*===\s*"loading"/);
  assert.match(source, /disabled=\{telegramLinkStatus\s*===\s*"loading"\}/);
  assert.match(source, /startsWith\(TELEGRAM_BOT_URL_PREFIX\)/);
  assert.match(source, /Unable to connect Telegram alerts\./);
  assert.match(source, /Telegram alerts connected\./);
  assert.doesNotMatch(source, /href=\{[^}]*apiKey/);
  assert.doesNotMatch(source, /href=["'][^"']*apiKey/);
});
