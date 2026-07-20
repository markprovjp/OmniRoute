import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_DIR = path.join(ROOT, ".dist", "telegram");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "telegram-token-bot.mjs");

fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, "scripts", "telegram", "token-bot.ts")],
  outdir: OUTPUT_DIR,
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: ["node26"],
  tsconfig: path.join(ROOT, "tsconfig.json"),
  entryNames: "telegram-token-bot",
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

fs.writeFileSync(
  path.join(OUTPUT_DIR, "telegram-token-bot.meta.json"),
  `${JSON.stringify(result.metafile, null, 2)}\n`
);

const output = fs.readFileSync(OUTPUT_FILE, "utf8");
if (/QROUTER_TELEGRAM_BOT_TOKEN\s*[:=]\s*["'][^"']+/.test(output)) {
  throw new Error("Telegram bundle contains an embedded bot token assignment");
}
