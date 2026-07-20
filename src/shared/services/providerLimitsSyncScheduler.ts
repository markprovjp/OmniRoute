import {
  getLastProviderLimitsAutoSyncTime,
  getProviderLimitsSyncIntervalMinutes,
  getProviderLimitsSyncIntervalMs,
} from "@/lib/usage/providerLimits";
import {
  startProviderLimitsRefreshJob,
  waitForProviderLimitsRefreshJob,
} from "@/lib/usage/providerLimitsRefreshJobs";

const STARTUP_DELAY_MS = 5_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function runProviderLimitsSyncCycle(): Promise<void> {
  const start = Date.now();

  try {
    const started = await startProviderLimitsRefreshJob("scheduled");
    const result = await waitForProviderLimitsRefreshJob(started.job.id);
    if (!result) {
      console.warn("[ProviderLimitsSync] Refresh job disappeared before completion");
      return;
    }
    console.log(
      `[ProviderLimitsSync] Job ${result.id.slice(0, 8)} complete: ${result.succeeded}/${result.total} synced in ${Date.now() - start}ms`
    );
  } catch (error) {
    console.warn("[ProviderLimitsSync] Cycle failed:", (error as Error).message);
  }
}

export function startProviderLimitsSyncScheduler(): void {
  if (schedulerTimer || startupTimer) {
    console.log("[ProviderLimitsSync] Scheduler already running — skipping start");
    return;
  }

  const intervalMs = getProviderLimitsSyncIntervalMs();
  const intervalMinutes = getProviderLimitsSyncIntervalMinutes();

  console.log(`[ProviderLimitsSync] Scheduler started — interval: ${intervalMinutes}m`);

  void (async () => {
    let initialDelayMs = STARTUP_DELAY_MS;
    const lastAutoSyncAt = await getLastProviderLimitsAutoSyncTime();

    if (lastAutoSyncAt) {
      const lastRunMs = Date.parse(lastAutoSyncAt);
      if (Number.isFinite(lastRunMs)) {
        const elapsedMs = Date.now() - lastRunMs;
        if (elapsedMs < intervalMs) {
          initialDelayMs = Math.max(intervalMs - elapsedMs, STARTUP_DELAY_MS);
        }
      }
    }

    startupTimer = setTimeout(() => {
      startupTimer = null;
      void runProviderLimitsSyncCycle();

      schedulerTimer = setInterval(() => {
        void runProviderLimitsSyncCycle();
      }, intervalMs);
      schedulerTimer.unref?.();
    }, initialDelayMs);

    startupTimer.unref?.();
  })();
}

export function stopProviderLimitsSyncScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[ProviderLimitsSync] Scheduler stopped");
  }
}
