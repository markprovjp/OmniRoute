import { cleanupExpiredLogs } from "@/lib/compliance/index";
import { cleanupDbBackups } from "@/lib/db/backup";
import { runLogRotationMaintenance } from "@/lib/logRotation";
import { rotateCallLogs } from "@/lib/usage/callLogs";
import { createLogger } from "@/shared/utils/logger";

const log = createLogger("runtime-maintenance");

const DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MIN_RUNTIME_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

declare global {
  var __omnirouteRuntimeMaintenance:
    | {
        interval: ReturnType<typeof setInterval> | null;
        startupTimer: ReturnType<typeof setTimeout> | null;
        running: boolean;
      }
    | undefined;
}

function getState() {
  if (!globalThis.__omnirouteRuntimeMaintenance) {
    globalThis.__omnirouteRuntimeMaintenance = {
      interval: null,
      startupTimer: null,
      running: false,
    };
  }
  return globalThis.__omnirouteRuntimeMaintenance;
}

function isEnvFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

function parseIntervalMs(value: string | undefined): number {
  if (!value) return DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS;
  return Math.max(MIN_RUNTIME_MAINTENANCE_INTERVAL_MS, parsed);
}

export function getRuntimeMaintenanceIntervalMs(): number {
  return parseIntervalMs(process.env.OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS);
}

export function isRuntimeMaintenanceDisabled(): boolean {
  return (
    isEnvFlagEnabled("OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE") ||
    isEnvFlagEnabled("OMNIROUTE_DISABLE_BACKGROUND_SERVICES") ||
    process.env.NODE_ENV === "test"
  );
}

export function runRuntimeMaintenance(source = "scheduled") {
  const state = getState();
  if (state.running) return null;
  state.running = true;

  try {
    const logs = cleanupExpiredLogs();
    runLogRotationMaintenance();
    rotateCallLogs();
    const backups = cleanupDbBackups();
    const changed =
      logs.deletedUsage ||
      logs.deletedCallLogs ||
      logs.deletedProxyLogs ||
      logs.deletedRequestDetailLogs ||
      logs.deletedAuditLogs ||
      logs.deletedMcpAuditLogs ||
      logs.trimmedCallLogs ||
      logs.trimmedProxyLogs ||
      backups.deletedBackupFamilies ||
      backups.deletedFiles;

    if (changed) {
      log.info({ source, logs, backups }, "Runtime maintenance cleanup completed");
    }

    return { logs, backups };
  } catch (err) {
    log.warn({ err, source }, "Runtime maintenance cleanup failed");
    return null;
  } finally {
    state.running = false;
  }
}

export function startRuntimeMaintenanceJob(): void {
  if (isRuntimeMaintenanceDisabled()) return;

  const state = getState();
  if (state.interval || state.startupTimer) return;

  const intervalMs = getRuntimeMaintenanceIntervalMs();
  state.startupTimer = setTimeout(() => {
    state.startupTimer = null;
    runRuntimeMaintenance("startup-delay");
  }, 30_000);
  state.startupTimer.unref?.();

  state.interval = setInterval(() => runRuntimeMaintenance("interval"), intervalMs);
  state.interval.unref?.();

  log.info({ intervalMs }, "Runtime maintenance job started");
}

export function stopRuntimeMaintenanceJob(): void {
  const state = getState();

  if (state.startupTimer) {
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
  }

  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }

  state.running = false;
}
