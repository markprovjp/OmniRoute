import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultRunCommand,
  deployOmniRoute,
  loadDeployConfig,
  type CommandOptions,
  type CommandResult,
  type DeployDependencies,
} from "../../scripts/deploy/omniroute-deploy.mjs";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRemoteRepository(root: string): { remote: string; worktree: string; sha: string } {
  const worktree = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "--initial-branch=main");
  git(worktree, "config", "user.email", "deploy-test@example.invalid");
  git(worktree, "config", "user.name", "Deploy Test");
  writeFileSync(
    path.join(worktree, "docker-compose.prod.yml"),
    [
      "services:",
      "  redis:",
      "    image: redis:8-alpine",
      "  omniroute-prod:",
      "    image: ${OMNIROUTE_IMAGE:-omniroute:prod}",
      "  omniroute-telegram-bot:",
      "    image: ${OMNIROUTE_TELEGRAM_IMAGE:-omniroute-telegram-bot:prod}",
      "  omniroute-watchdog:",
      "    image: docker:27-cli",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(worktree, "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(worktree, "Dockerfile.telegram"), "FROM scratch\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "initial");
  const sha = git(worktree, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", worktree, remote], { encoding: "utf8" });
  git(worktree, "remote", "add", "origin", remote);
  return { remote, worktree, sha };
}

function appendCommit(worktree: string): string {
  writeFileSync(path.join(worktree, "release-marker.txt"), `${Date.now()}\n`);
  git(worktree, "add", "release-marker.txt");
  git(worktree, "commit", "-m", "next release");
  git(worktree, "push", "origin", "main");
  return git(worktree, "rev-parse", "HEAD");
}

function createConfig(root: string, remote: string): string {
  const sharedDir = path.join(root, "shared");
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(path.join(sharedDir, ".env"), "NODE_ENV=production\n", { mode: 0o600 });
  const configPath = path.join(root, "deploy.env");
  writeFileSync(
    configPath,
    [
      `REPO_URL=${remote}`,
      "DEPLOY_REF=main",
      `REPO_CACHE=${path.join(root, "repo.git")}`,
      `RELEASE_ROOT=${path.join(root, "releases")}`,
      `STATE_DIR=${path.join(root, "state")}`,
      `CURRENT_LINK=${path.join(root, "current")}`,
      `SHARED_ENV=${path.join(sharedDir, ".env")}`,
      `SHARED_TELEGRAM_ENV=${path.join(sharedDir, ".env.telegram")}`,
      `LEGACY_RELEASE_DIR=${path.join(root, "legacy")}`,
      "COMPOSE_PROJECT_NAME=omniroute",
      "COMPOSE_FILE=docker-compose.prod.yml",
      "LOCAL_HEALTH_URL=http://local.test/",
      "PUBLIC_HEALTH_URL=https://public.test/",
      "HEALTH_TIMEOUT_SECONDS=1",
      "HEALTH_INTERVAL_MS=1",
      "BACKUP_RETENTION=3",
      "",
    ].join("\n")
  );
  return configPath;
}

function createFakeDependencies(): DeployDependencies & {
  calls: string[];
  currentAppImage: () => string;
  currentBotImage: () => string;
  setFailImage: (image: string | null) => void;
} {
  const calls: string[] = [];
  let appImage = "omniroute:old";
  let botImage = "omniroute-telegram-bot:old";
  let failImage: string | null = null;

  const runCommand = async (
    command: string,
    args: string[],
    options: CommandOptions = {}
  ): Promise<CommandResult> => {
    if (command === "git" || command === "tar") {
      return defaultRunCommand(command, args, options);
    }

    const effectiveAppImage = options.env?.OMNIROUTE_IMAGE ?? appImage;
    const effectiveBotImage = options.env?.OMNIROUTE_TELEGRAM_IMAGE ?? botImage;
    calls.push(`${effectiveAppImage}|${effectiveBotImage}|${command} ${args.join(" ")}`);

    if (command === "curl") return { code: 0, stdout: "", stderr: "" };
    if (command !== "docker") throw new Error(`Unexpected command: ${command}`);

    if (args[0] === "inspect") {
      const format = args[2] ?? "";
      const container = args[3] ?? "";
      if (format.includes("com.docker.compose.project.working_dir")) {
        return { code: 0, stdout: options.cwd ?? "", stderr: "" };
      }
      if (format.includes(".Config.Image")) {
        return {
          code: 0,
          stdout: container === "omniroute-prod" ? appImage : botImage,
          stderr: "",
        };
      }
      if (format.includes(".State.Health")) {
        const status = appImage === failImage ? "unhealthy" : "healthy";
        return { code: 0, stdout: status, stderr: "" };
      }
      if (format.includes(".State.Running")) {
        return { code: 0, stdout: "true", stderr: "" };
      }
    }

    if (args[0] === "compose" && args.includes("up")) {
      if (args.includes("omniroute-prod")) appImage = effectiveAppImage;
      if (args.includes("omniroute-telegram-bot")) botImage = effectiveBotImage;
    }

    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    calls,
    currentAppImage: () => appImage,
    currentBotImage: () => botImage,
    setFailImage: (image) => {
      failImage = image;
    },
    runCommand,
    sleep: async () => {},
    now: () => new Date("2026-07-20T17:00:00.000Z"),
    log: () => {},
  };
}

test("production compose accepts immutable image tags and an optional Telegram env file", () => {
  const compose = readFileSync("docker-compose.prod.yml", "utf8");
  assert.match(compose, /image:\s*\$\{OMNIROUTE_IMAGE:-omniroute:prod\}/);
  assert.match(compose, /image:\s*\$\{OMNIROUTE_TELEGRAM_IMAGE:-omniroute-telegram-bot:prod\}/);
  assert.match(compose, /path:\s*\.env\.telegram[\s\S]*required:\s*false/);
});

test("systemd owns deployment outside the app container and leaves polling disabled", () => {
  const service = readFileSync("scripts/deploy/systemd/omniroute-deploy.service", "utf8");
  const timer = readFileSync("scripts/deploy/systemd/omniroute-deploy.timer", "utf8");
  const installer = readFileSync("scripts/deploy/install-vps-auto-deploy.sh", "utf8");
  assert.match(service, /ExecStart=\/usr\/bin\/flock[^\n]+omniroute-deploy\.mjs/);
  assert.match(service, /After=network-online\.target docker\.service/);
  assert.match(service, /TimeoutStartSec=45min/);
  assert.match(service, /DOCKER_CONFIG=\/var\/lib\/omniroute-deploy\/docker-config/);
  assert.match(installer, /install -d -m 0700 \/var\/lib\/omniroute-deploy\/docker-config/);
  assert.match(timer, /OnUnitInactiveSec=5min/);
  assert.doesNotMatch(installer, /^systemctl enable --now omniroute-deploy\.timer/m);
});

test("loadDeployConfig rejects a missing primary environment file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "omniroute-deploy-config-"));
  const { remote } = createRemoteRepository(root);
  const configPath = createConfig(root, remote);
  const configText = readFileSync(configPath, "utf8").replace(
    /SHARED_ENV=.*/,
    `SHARED_ENV=${path.join(root, "missing.env")}`
  );
  writeFileSync(configPath, configText);
  assert.throws(() => loadDeployConfig(configPath), /SHARED_ENV/);
});

test("deploy builds before the swap, records immutable state, and skips an unchanged SHA", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "omniroute-deploy-success-"));
  const { remote, sha } = createRemoteRepository(root);
  const config = loadDeployConfig(createConfig(root, remote));
  const deps = createFakeDependencies();

  const result = await deployOmniRoute(config, deps);
  assert.equal(result.status, "deployed");
  assert.equal(result.sha, sha);
  assert.equal(deps.currentAppImage(), `omniroute:${sha}`);
  assert.equal(deps.currentBotImage(), `omniroute-telegram-bot:${sha}`);

  const buildIndex = deps.calls.findIndex(
    (call) => call.includes(" compose ") && call.includes("build")
  );
  const backupIndex = deps.calls.findIndex((call) => call.includes("DEPLOY_BACKUP_PATH="));
  const stopIndex = deps.calls.findIndex((call) => call.includes("docker stop"));
  const appUpIndex = deps.calls.findIndex(
    (call) => call.includes(" compose ") && call.includes("up") && call.includes("omniroute-prod")
  );
  assert.ok(buildIndex >= 0, "candidate image must be built");
  assert.ok(backupIndex > buildIndex, "online SQLite backup must follow a successful build");
  assert.ok(stopIndex > backupIndex, "watchdog must stop only after the online backup succeeds");
  assert.ok(appUpIndex > stopIndex, "application swap must happen after watchdog is stopped");
  assert.equal(
    deps.calls.some((call) => call.includes(" down") || /up .*\bredis\b/.test(call)),
    false,
    "deployment must not stop or recreate Redis"
  );

  const state = JSON.parse(readFileSync(path.join(config.stateDir, "current.json"), "utf8"));
  assert.equal(state.sha, sha);
  assert.equal(state.appImage, `omniroute:${sha}`);
  assert.match(state.backupPath, /deploy_[a-f0-9]{12}_20260720T170000Z\.sqlite$/);

  deps.calls.length = 0;
  const second = await deployOmniRoute(config, deps);
  assert.equal(second.status, "unchanged");
  assert.equal(
    deps.calls.some((call) => call.includes("build")),
    false
  );
});

test("a failed candidate rolls back to the previous healthy release and images", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "omniroute-deploy-rollback-"));
  const { remote, worktree, sha: firstSha } = createRemoteRepository(root);
  const config = loadDeployConfig(createConfig(root, remote));
  const deps = createFakeDependencies();
  await deployOmniRoute(config, deps);
  assert.equal(deps.currentAppImage(), `omniroute:${firstSha}`);

  const failedSha = appendCommit(worktree);
  deps.setFailImage(`omniroute:${failedSha}`);
  deps.calls.length = 0;

  await assert.rejects(() => deployOmniRoute(config, deps), /candidate|health/i);
  assert.equal(deps.currentAppImage(), `omniroute:${firstSha}`);
  assert.equal(deps.currentBotImage(), `omniroute-telegram-bot:${firstSha}`);

  const candidateUp = deps.calls.findIndex(
    (call) => call.startsWith(`omniroute:${failedSha}|`) && call.includes("up")
  );
  const rollbackUp = deps.calls.findIndex(
    (call, index) =>
      index > candidateUp && call.startsWith(`omniroute:${firstSha}|`) && call.includes("up")
  );
  assert.ok(candidateUp >= 0, "failed candidate must have been started");
  assert.ok(rollbackUp > candidateUp, "previous image must be recreated after candidate failure");

  const state = JSON.parse(readFileSync(path.join(config.stateDir, "current.json"), "utf8"));
  assert.equal(state.sha, firstSha, "failed candidates must not replace healthy state");
});
