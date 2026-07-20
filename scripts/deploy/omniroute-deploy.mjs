#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_SERVICE = "omniroute-prod";
const BOT_SERVICE = "omniroute-telegram-bot";
const WATCHDOG_SERVICE = "omniroute-watchdog";
const APP_CONTAINER = "omniroute-prod";
const BOT_CONTAINER = "omniroute-telegram-bot";
const WATCHDOG_CONTAINER = "omniroute-watchdog";

const BACKUP_SCRIPT = String.raw`
const Database = require("better-sqlite3");
const target = process.env.DEPLOY_BACKUP_PATH;
if (!target || !target.startsWith("/app/data/db_backups/deploy_")) {
  throw new Error("Invalid deployment backup path");
}
(async () => {
  const db = new Database("/app/data/storage.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await db.backup(target);
    console.log(target);
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite backup failed");
  process.exit(1);
});
`;

const PRUNE_BACKUPS_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const directory = "/app/data/db_backups";
const retention = Math.max(1, Number.parseInt(process.env.DEPLOY_BACKUP_RETENTION || "5", 10));
if (!fs.existsSync(directory)) process.exit(0);
const files = fs.readdirSync(directory)
  .filter((name) => /^deploy_[a-f0-9]{12}_\d{8}T\d{6}Z\.sqlite$/.test(name))
  .map((name) => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const file of files.slice(retention)) fs.rmSync(path.join(directory, file.name));
`;

const IMAGE_SMOKE_SCRIPT = String.raw`
const fs = require("node:fs");
for (const file of ["server.js", "healthcheck.mjs"]) {
  if (!fs.existsSync(file)) {
    console.error("Missing runtime file: " + file);
    process.exit(1);
  }
}
`;

function parseEnvFile(filePath) {
  const values = {};
  for (const [index, sourceLine] of readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid config line ${index + 1} in ${filePath}`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid config key on line ${index + 1} in ${filePath}`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parsePositiveNumber(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function assertAbsolute(filePath, name) {
  if (!path.isAbsolute(filePath)) throw new Error(`${name} must be an absolute path`);
}

export function loadDeployConfig(
  configPath = process.env.OMNIROUTE_DEPLOY_CONFIG || "/etc/omniroute-deploy.env"
) {
  if (!existsSync(configPath)) throw new Error(`Deployment config not found: ${configPath}`);
  const raw = parseEnvFile(configPath);
  const config = {
    repoUrl: raw.REPO_URL || "https://github.com/markprovjp/OmniRoute.git",
    deployRef: raw.DEPLOY_REF || "main",
    repoCache: raw.REPO_CACHE || "/var/lib/omniroute-deploy/repo.git",
    releaseRoot: raw.RELEASE_ROOT || "/opt/omniroute-releases",
    stateDir: raw.STATE_DIR || "/var/lib/omniroute-deploy",
    currentLink: raw.CURRENT_LINK || "/opt/omniroute-current",
    sharedEnv: raw.SHARED_ENV || "/opt/omniroute/.env",
    sharedTelegramEnv: raw.SHARED_TELEGRAM_ENV || "/opt/omniroute/.env.telegram",
    legacyReleaseDir: raw.LEGACY_RELEASE_DIR || "/opt/omniroute",
    composeProjectName: raw.COMPOSE_PROJECT_NAME || "omniroute",
    composeFile: raw.COMPOSE_FILE || "docker-compose.prod.yml",
    localHealthUrl: raw.LOCAL_HEALTH_URL || "http://127.0.0.1:20130/",
    publicHealthUrl: raw.PUBLIC_HEALTH_URL || "https://customer.qrouter.online/",
    healthTimeoutSeconds: parsePositiveNumber(
      raw.HEALTH_TIMEOUT_SECONDS,
      120,
      "HEALTH_TIMEOUT_SECONDS"
    ),
    healthIntervalMs: parsePositiveNumber(raw.HEALTH_INTERVAL_MS, 2000, "HEALTH_INTERVAL_MS"),
    backupRetention: Math.max(
      1,
      Math.floor(parsePositiveNumber(raw.BACKUP_RETENTION, 5, "BACKUP_RETENTION"))
    ),
  };

  for (const [name, value] of [
    ["REPO_CACHE", config.repoCache],
    ["RELEASE_ROOT", config.releaseRoot],
    ["STATE_DIR", config.stateDir],
    ["CURRENT_LINK", config.currentLink],
    ["SHARED_ENV", config.sharedEnv],
    ["SHARED_TELEGRAM_ENV", config.sharedTelegramEnv],
    ["LEGACY_RELEASE_DIR", config.legacyReleaseDir],
  ]) {
    assertAbsolute(value, name);
  }
  if (!existsSync(config.sharedEnv)) {
    throw new Error(`SHARED_ENV does not exist: ${config.sharedEnv}`);
  }
  if (/\s/.test(config.deployRef) || config.deployRef.startsWith("-")) {
    throw new Error("DEPLOY_REF contains unsupported characters");
  }
  if (config.repoUrl.includes("://")) {
    const parsedUrl = new URL(config.repoUrl);
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error("REPO_URL must not contain embedded credentials");
    }
  }
  return config;
}

export async function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true || options.allowFailure === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code === 0 || options.allowFailure) {
        resolve(result);
        return;
      }
      const detail = result.stderr ? `: ${result.stderr}` : "";
      reject(new Error(`${command} exited with code ${result.code}${detail}`));
    });
  });
}

function defaultLog(message) {
  console.log(`[omniroute-deploy] ${new Date().toISOString()} ${message}`);
}

function readState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (!value || typeof value !== "object" || typeof value.sha !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function writeStateAtomic(statePath, state) {
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

function linkSecret(source, destination) {
  rmSync(destination, { force: true });
  if (!existsSync(source)) return;
  try {
    symlinkSync(source, destination, "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

function updateCurrentLink(target, currentLink) {
  const temporaryLink = `${currentLink}.tmp-${process.pid}`;
  rmSync(temporaryLink, { force: true, recursive: true });
  symlinkSync(target, temporaryLink, "dir");
  if (existsSync(currentLink)) {
    const stat = lstatSync(currentLink);
    if (!stat.isSymbolicLink()) {
      throw new Error(`CURRENT_LINK exists and is not a symlink: ${currentLink}`);
    }
  }
  renameSync(temporaryLink, currentLink);
}

function composeInvocation(config, releaseDir, appImage, botImage, composeArgs) {
  return {
    command: "docker",
    args: [
      "compose",
      "--project-name",
      config.composeProjectName,
      "--env-file",
      path.join(releaseDir, ".env"),
      "-f",
      path.join(releaseDir, config.composeFile),
      ...composeArgs,
    ],
    options: {
      cwd: releaseDir,
      env: {
        OMNIROUTE_IMAGE: appImage,
        OMNIROUTE_TELEGRAM_IMAGE: botImage,
      },
    },
  };
}

async function runCompose(deps, config, releaseDir, appImage, botImage, args, options = {}) {
  const invocation = composeInvocation(config, releaseDir, appImage, botImage, args);
  return deps.runCommand(invocation.command, invocation.args, {
    ...invocation.options,
    ...options,
    env: { ...invocation.options.env, ...(options.env || {}) },
  });
}

async function inspectValue(deps, format, container, allowFailure = false) {
  const result = await deps.runCommand("docker", ["inspect", "-f", format, container], {
    capture: true,
    allowFailure,
  });
  if (result.code !== 0) return "";
  return result.stdout.trim();
}

async function verifyEndpoint(deps, url) {
  const result = await deps.runCommand(
    "curl",
    ["--fail", "--silent", "--show-error", "--max-time", "8", "--output", "/dev/null", url],
    { capture: true, allowFailure: true }
  );
  if (result.code !== 0) throw new Error(`Health endpoint failed: ${url}`);
}

async function waitForHealthyApp(config, deps, verifyHttp = true) {
  const attempts = Math.max(
    1,
    Math.ceil((config.healthTimeoutSeconds * 1000) / config.healthIntervalMs)
  );
  let lastStatus = "missing";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastStatus =
      (await inspectValue(
        deps,
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
        APP_CONTAINER,
        true
      )) || "missing";
    if (lastStatus === "healthy") {
      if (verifyHttp) {
        await verifyEndpoint(deps, config.localHealthUrl);
        await verifyEndpoint(deps, config.publicHealthUrl);
      }
      return;
    }
    if (attempt + 1 < attempts) await deps.sleep(config.healthIntervalMs);
  }
  throw new Error(`Candidate health check failed with status: ${lastStatus}`);
}

async function verifySupportingContainers(deps) {
  for (const container of [BOT_CONTAINER, WATCHDOG_CONTAINER]) {
    const running = await inspectValue(deps, "{{.State.Running}}", container, true);
    if (running !== "true") throw new Error(`${container} is not running`);
  }
}

async function ensureRepository(config, deps) {
  mkdirSync(path.dirname(config.repoCache), { recursive: true });
  if (!existsSync(path.join(config.repoCache, "HEAD"))) {
    deps.log("creating read-only Git mirror");
    await deps.runCommand("git", ["clone", "--mirror", config.repoUrl, config.repoCache]);
  }
  await deps.runCommand(
    "git",
    ["--git-dir", config.repoCache, "fetch", "--force", "--prune", "origin", config.deployRef],
    { capture: true }
  );
  const resolved = await deps.runCommand(
    "git",
    ["--git-dir", config.repoCache, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    { capture: true }
  );
  if (!/^[a-f0-9]{40}$/.test(resolved.stdout)) {
    throw new Error("Git ref did not resolve to one commit");
  }
  return resolved.stdout;
}

async function ensureRelease(config, deps, sha) {
  mkdirSync(config.releaseRoot, { recursive: true });
  const releaseDir = path.join(config.releaseRoot, sha);
  const composePath = path.join(releaseDir, config.composeFile);
  if (!existsSync(composePath)) {
    const temporaryDir = `${releaseDir}.tmp-${process.pid}`;
    rmSync(temporaryDir, { force: true, recursive: true });
    mkdirSync(temporaryDir, { recursive: true, mode: 0o750 });
    await deps.runCommand("git", [
      "--git-dir",
      config.repoCache,
      "--work-tree",
      temporaryDir,
      "checkout",
      "--force",
      sha,
      "--",
      ".",
    ]);
    renameSync(temporaryDir, releaseDir);
  }
  linkSecret(config.sharedEnv, path.join(releaseDir, ".env"));
  linkSecret(config.sharedTelegramEnv, path.join(releaseDir, ".env.telegram"));
  if (!existsSync(composePath))
    throw new Error(`Compose file missing from release: ${composePath}`);
  return releaseDir;
}

async function createOnlineBackup(config, deps, sha) {
  const stamp = deps
    .now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const backupPath = `/app/data/db_backups/deploy_${sha.slice(0, 12)}_${stamp}.sqlite`;
  await deps.runCommand("docker", ["exec", APP_CONTAINER, "mkdir", "-p", "/app/data/db_backups"]);
  await deps.runCommand("docker", [
    "exec",
    "-e",
    `DEPLOY_BACKUP_PATH=${backupPath}`,
    APP_CONTAINER,
    "node",
    "-e",
    BACKUP_SCRIPT,
  ]);
  return backupPath;
}

async function pruneOnlineBackups(config, deps) {
  await deps.runCommand(
    "docker",
    [
      "exec",
      "-e",
      `DEPLOY_BACKUP_RETENTION=${config.backupRetention}`,
      APP_CONTAINER,
      "node",
      "-e",
      PRUNE_BACKUPS_SCRIPT,
    ],
    { allowFailure: true, capture: true }
  );
}

async function hasService(config, deps, releaseDir, appImage, botImage, service) {
  const result = await runCompose(
    deps,
    config,
    releaseDir,
    appImage,
    botImage,
    ["config", "--services"],
    { capture: true, allowFailure: true }
  );
  return result.code === 0 && result.stdout.split(/\r?\n/).includes(service);
}

async function rollbackApplication(config, deps, previous, candidateRelease) {
  const releaseDir =
    previous.releaseDir && existsSync(path.join(previous.releaseDir, config.composeFile))
      ? previous.releaseDir
      : candidateRelease;
  deps.log(`rolling back application images using ${releaseDir}`);
  await deps.runCommand("docker", ["stop", "--time", "10", WATCHDOG_CONTAINER], {
    allowFailure: true,
    capture: true,
  });
  await runCompose(deps, config, releaseDir, previous.appImage, previous.botImage, [
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    APP_SERVICE,
  ]);
  await waitForHealthyApp(config, deps);
  const supportRelease = (await hasService(
    config,
    deps,
    releaseDir,
    previous.appImage,
    previous.botImage,
    BOT_SERVICE
  ))
    ? releaseDir
    : candidateRelease;
  await runCompose(deps, config, supportRelease, previous.appImage, previous.botImage, [
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    BOT_SERVICE,
    WATCHDOG_SERVICE,
  ]);
  await deps.sleep(2000);
  await verifySupportingContainers(deps);
  deps.log("rollback health verification passed");
}

export async function deployOmniRoute(config, dependencies = {}) {
  const deps = {
    runCommand: dependencies.runCommand || defaultRunCommand,
    sleep:
      dependencies.sleep ||
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: dependencies.now || (() => new Date()),
    log: dependencies.log || defaultLog,
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.releaseRoot, { recursive: true, mode: 0o750 });
  const statePath = path.join(config.stateDir, "current.json");
  const previousState = readState(statePath);

  const sha = await ensureRepository(config, deps);
  if (previousState?.sha === sha) {
    try {
      await waitForHealthyApp(config, deps);
      await verifySupportingContainers(deps);
      deps.log(`commit ${sha} is already deployed and healthy`);
      return { status: "unchanged", sha };
    } catch {
      deps.log(`commit ${sha} is recorded but unhealthy; recreating it`);
    }
  }

  const releaseDir = await ensureRelease(config, deps, sha);
  const appImage = `omniroute:${sha}`;
  const botImage = `omniroute-telegram-bot:${sha}`;
  const inspectedRelease = await inspectValue(
    deps,
    '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
    APP_CONTAINER,
    true
  );
  const previous = {
    releaseDir: previousState?.releaseDir || inspectedRelease || config.legacyReleaseDir,
    appImage:
      (await inspectValue(deps, "{{.Config.Image}}", APP_CONTAINER, false)) ||
      previousState?.appImage ||
      "omniroute:prod",
    botImage:
      (await inspectValue(deps, "{{.Config.Image}}", BOT_CONTAINER, true)) ||
      previousState?.botImage ||
      "omniroute-telegram-bot:prod",
  };

  deps.log(`validating release ${sha}`);
  await runCompose(deps, config, releaseDir, appImage, botImage, ["config", "--quiet"]);
  deps.log("building candidate images while production remains online");
  await runCompose(deps, config, releaseDir, appImage, botImage, [
    "build",
    "--pull",
    APP_SERVICE,
    BOT_SERVICE,
  ]);
  await deps.runCommand("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    appImage,
    "-e",
    IMAGE_SMOKE_SCRIPT,
  ]);
  const backupPath = await createOnlineBackup(config, deps, sha);
  deps.log(`online SQLite backup created at ${backupPath}`);

  let swapStarted = false;
  try {
    await deps.runCommand("docker", ["stop", "--time", "10", WATCHDOG_CONTAINER], {
      allowFailure: true,
      capture: true,
    });
    swapStarted = true;
    deps.log("recreating the application container with the candidate image");
    await runCompose(deps, config, releaseDir, appImage, botImage, [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      APP_SERVICE,
    ]);
    await waitForHealthyApp(config, deps);
    deps.log("candidate application passed container and HTTP health checks");
    await runCompose(deps, config, releaseDir, appImage, botImage, [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      BOT_SERVICE,
      WATCHDOG_SERVICE,
    ]);
    await deps.sleep(2000);
    await verifySupportingContainers(deps);

    const deployedAt = deps.now().toISOString();
    writeStateAtomic(statePath, {
      sha,
      releaseDir,
      appImage,
      botImage,
      backupPath,
      deployedAt,
    });
    updateCurrentLink(releaseDir, config.currentLink);
    await pruneOnlineBackups(config, deps);
    deps.log(`deployment completed successfully at commit ${sha}`);
    return { status: "deployed", sha, backupPath, releaseDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown deployment failure";
    deps.log(`candidate deployment failed: ${message}`);
    if (swapStarted) {
      try {
        await rollbackApplication(config, deps, previous, releaseDir);
      } catch (rollbackError) {
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : "Unknown rollback failure";
        throw new Error(
          `Candidate failed (${message}); automatic rollback also failed (${rollbackMessage})`
        );
      }
    }
    throw new Error(`Candidate deployment failed: ${message}`);
  }
}

async function main() {
  const config = loadDeployConfig();
  await deployOmniRoute(config);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `[omniroute-deploy] ${new Date().toISOString()} ERROR ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    process.exitCode = 1;
  });
}
