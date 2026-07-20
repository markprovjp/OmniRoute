import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { load } from "js-yaml";

const ROOT = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("production compose defines an isolated Telegram sidecar with one shared data volume", () => {
  const compose = load(read("docker-compose.prod.yml")) as {
    services?: Record<string, Record<string, unknown>>;
  };
  const service = compose.services?.["omniroute-telegram-bot"];

  assert.ok(service);
  assert.equal(service.image, "omniroute-telegram-bot:prod");
  assert.equal(service.restart, "unless-stopped");
  assert.deepEqual(service.depends_on, {
    "omniroute-prod": { condition: "service_healthy" },
  });
  assert.deepEqual(service.env_file, [".env", ".env.telegram"]);
  assert.deepEqual(service.environment, [
    "NODE_ENV=production",
    "DATA_DIR=/app/data",
    "OMNIROUTE_MIGRATIONS_DIR=/app/migrations",
  ]);
  assert.deepEqual(service.volumes, ["omniroute-prod-data:/app/data"]);
  assert.deepEqual(service.command, ["node", "telegram/telegram-token-bot.mjs"]);
  assert.deepEqual(service.healthcheck, { disable: true });
  assert.equal("ports" in service, false);
});

test("Telegram Docker image contains only the bundled runtime and migrations", () => {
  const dockerfile = read("Dockerfile.telegram");

  assert.match(dockerfile, /^FROM node:26\.2\.0-trixie-slim AS builder/m);
  assert.match(dockerfile, /RUN npm run build:telegram/);
  assert.match(dockerfile, /COPY --from=builder \/app\/\.dist\/telegram \.\/telegram/);
  assert.match(dockerfile, /COPY --from=builder \/app\/src\/lib\/db\/migrations \.\/migrations/);
  assert.match(dockerfile, /CMD \["node", "telegram\/telegram-token-bot\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /COPY .*\.env|ADD .*\.env/i);

  const dockerignore = read(".dockerignore");
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^!\.env\.example$/m);
  assert.match(read(".gitignore"), /^\.dist\/$/m);
});

test("bundle script targets Node 26 and never embeds production credentials", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const buildScript = read("scripts/build/build-telegram-bot.mjs");

  assert.equal(
    packageJson.scripts?.["build:telegram"],
    "node scripts/build/build-telegram-bot.mjs"
  );
  assert.equal(typeof packageJson.devDependencies?.esbuild, "string");
  assert.match(buildScript, /target:\s*\[?"node26"/);
  assert.match(buildScript, /platform:\s*"node"/);
  assert.match(buildScript, /format:\s*"esm"/);
  assert.match(buildScript, /splitting:\s*true/);
  assert.match(buildScript, /createRequire/);
  assert.match(buildScript, /telegram-token-bot/);
  assert.doesNotMatch(buildScript, /QROUTER_TELEGRAM_BOT_TOKEN\s*[:=]\s*["'][^"']+/);
});

test("built ESM entry parses and reaches guarded startup without dynamic-require failures", () => {
  const node = process.execPath;
  const build = spawnSync(node, ["scripts/build/build-telegram-bot.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);

  const entry = path.join(ROOT, ".dist", "telegram", "telegram-token-bot.mjs");
  const started = spawnSync(node, [entry], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, QROUTER_TELEGRAM_BOT_TOKEN: "" },
  });

  assert.equal(started.status, 1);
  assert.match(started.stderr, /Telegram token bot failed to start/);
  assert.doesNotMatch(started.stderr, /SyntaxError|Dynamic require/);
});
