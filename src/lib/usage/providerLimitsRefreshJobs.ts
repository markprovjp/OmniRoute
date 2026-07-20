import { randomUUID } from "node:crypto";
import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import type { syncAllProviderLimits, SyncAllProviderLimitsOptions } from "./providerLimits";
import type { ProviderLimitsRefreshEvent } from "./providerLimitsRefreshEngine";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export type ProviderLimitsRefreshJobSource = "manual" | "scheduled";
export type ProviderLimitsRefreshJobState = "running" | "completed" | "failed";

export type ProviderLimitsRefreshJobUpdate =
  ProviderLimitsRefreshEvent<ProviderLimitsCacheEntry> & {
    sequence: number;
  };

export interface ProviderLimitsRefreshJobSnapshot {
  id: string;
  source: ProviderLimitsRefreshJobSource;
  state: ProviderLimitsRefreshJobState;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cursor: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ProviderLimitsRefreshJobReadResult {
  job: ProviderLimitsRefreshJobSnapshot;
  updates: ProviderLimitsRefreshJobUpdate[];
}

export type ProviderLimitsRefreshJobRunner = (
  options: SyncAllProviderLimitsOptions
) => ReturnType<typeof syncAllProviderLimits>;

interface InternalRefreshJob {
  id: string;
  source: ProviderLimitsRefreshJobSource;
  state: ProviderLimitsRefreshJobState;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cursor: number;
  updates: ProviderLimitsRefreshJobUpdate[];
  startedAt: string;
  startedAtMs: number;
  completedAt: string | null;
  completedAtMs: number | null;
  error: string | null;
  completion: Promise<ProviderLimitsRefreshJobSnapshot>;
}

export interface ProviderLimitsRefreshJobCoordinatorOptions {
  runSync?: ProviderLimitsRefreshJobRunner;
  now?: () => number;
  idFactory?: () => string;
  jobTtlMs?: number;
  maxCompletedJobs?: number;
}

export interface ProviderLimitsRefreshJobCoordinator {
  start(source?: ProviderLimitsRefreshJobSource): Promise<{
    job: ProviderLimitsRefreshJobSnapshot;
    deduplicated: boolean;
  }>;
  get(jobId: string, after?: number): ProviderLimitsRefreshJobReadResult | null;
  getActive(): ProviderLimitsRefreshJobSnapshot | null;
  wait(jobId: string): Promise<ProviderLimitsRefreshJobSnapshot | null>;
}

const DEFAULT_JOB_TTL_MS = 600_000;
const DEFAULT_MAX_COMPLETED_JOBS = 3;

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function publicSnapshot(job: InternalRefreshJob): ProviderLimitsRefreshJobSnapshot {
  return {
    id: job.id,
    source: job.source,
    state: job.state,
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    cursor: job.cursor,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

function safeJobError(error: unknown): string {
  return (sanitizeErrorMessage(error) || "Failed to refresh provider limits").slice(0, 240);
}

export function createProviderLimitsRefreshJobCoordinator(
  options: ProviderLimitsRefreshJobCoordinatorOptions = {}
): ProviderLimitsRefreshJobCoordinator {
  const runSync: ProviderLimitsRefreshJobRunner =
    options.runSync ||
    (async (syncOptions) => {
      const { syncAllProviderLimits: run } = await import("./providerLimits");
      return run(syncOptions);
    });
  const now = options.now || Date.now;
  const idFactory = options.idFactory || randomUUID;
  const jobs = new Map<string, InternalRefreshJob>();
  let activeJobId: string | null = null;

  const getTtlMs = () =>
    clampInteger(
      options.jobTtlMs ?? process.env.PROVIDER_LIMITS_REFRESH_JOB_TTL_MS,
      DEFAULT_JOB_TTL_MS,
      1,
      86_400_000
    );
  const maxCompletedJobs = clampInteger(
    options.maxCompletedJobs,
    DEFAULT_MAX_COMPLETED_JOBS,
    1,
    20
  );

  const prune = () => {
    const cutoff = now() - getTtlMs();
    for (const [jobId, job] of jobs) {
      if (job.completedAtMs !== null && job.completedAtMs < cutoff) jobs.delete(jobId);
    }

    const completed = [...jobs.values()]
      .filter((job) => job.completedAtMs !== null)
      .sort((a, b) => (b.completedAtMs || 0) - (a.completedAtMs || 0));
    for (const job of completed.slice(maxCompletedJobs)) jobs.delete(job.id);
  };

  const getInternalActive = () => {
    if (!activeJobId) return null;
    const job = jobs.get(activeJobId) || null;
    if (!job || job.state !== "running") {
      activeJobId = null;
      return null;
    }
    return job;
  };

  return {
    async start(source = "manual") {
      prune();
      const active = getInternalActive();
      if (active) return { job: publicSnapshot(active), deduplicated: true };

      const startedAtMs = now();
      const started = Promise.withResolvers<void>();
      let startSignaled = false;
      const signalStarted = () => {
        if (startSignaled) return;
        startSignaled = true;
        started.resolve();
      };

      const job: InternalRefreshJob = {
        id: idFactory(),
        source,
        state: "running" as const,
        total: 0,
        completed: 0,
        succeeded: 0,
        failed: 0,
        cursor: 0,
        updates: [],
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        completedAt: null,
        completedAtMs: null,
        error: null,
        completion: Promise.resolve(null as unknown as ProviderLimitsRefreshJobSnapshot),
      };

      jobs.set(job.id, job);
      activeJobId = job.id;
      job.completion = (async () => {
        try {
          const summary = await runSync({
            source,
            onStart: async (total) => {
              job.total = total;
              signalStarted();
            },
            onProgress: async (event) => {
              job.cursor += 1;
              const update: ProviderLimitsRefreshJobUpdate = {
                ...event,
                ...(event.status === "failed" ? { error: safeJobError(event.error) } : {}),
                sequence: job.cursor,
              };
              job.updates.push(update);
              job.completed += 1;
              if (update.status === "succeeded") job.succeeded += 1;
              else job.failed += 1;
            },
          });

          job.total = summary.total;
          job.completed = summary.total;
          job.succeeded = summary.succeeded;
          job.failed = summary.failed;
          job.state = "completed";
        } catch (error) {
          job.state = "failed";
          job.error = safeJobError(error);
        } finally {
          signalStarted();
          const completedAtMs = now();
          job.completedAtMs = completedAtMs;
          job.completedAt = new Date(completedAtMs).toISOString();
          if (activeJobId === job.id) activeJobId = null;
        }
        return publicSnapshot(job);
      })();

      await started.promise;
      return { job: publicSnapshot(job), deduplicated: false };
    },

    get(jobId, after = 0) {
      prune();
      const job = jobs.get(jobId);
      if (!job) return null;
      return {
        job: publicSnapshot(job),
        updates: job.updates.filter((update) => update.sequence > after),
      };
    },

    getActive() {
      prune();
      const job = getInternalActive();
      return job ? publicSnapshot(job) : null;
    },

    async wait(jobId) {
      prune();
      const job = jobs.get(jobId);
      if (!job) return null;
      return job.completion;
    },
  };
}

const PROVIDER_LIMITS_REFRESH_JOBS_SYMBOL = Symbol.for("omniroute.providerLimitsRefreshJobs");
const globalJobRegistry = globalThis as typeof globalThis & {
  [key: symbol]: ProviderLimitsRefreshJobCoordinator | undefined;
};

export const providerLimitsRefreshJobs =
  globalJobRegistry[PROVIDER_LIMITS_REFRESH_JOBS_SYMBOL] ||
  (globalJobRegistry[PROVIDER_LIMITS_REFRESH_JOBS_SYMBOL] =
    createProviderLimitsRefreshJobCoordinator());

export function startProviderLimitsRefreshJob(source: ProviderLimitsRefreshJobSource = "manual") {
  return providerLimitsRefreshJobs.start(source);
}

export function getProviderLimitsRefreshJob(jobId: string, after = 0) {
  return providerLimitsRefreshJobs.get(jobId, after);
}

export function getActiveProviderLimitsRefreshJob() {
  return providerLimitsRefreshJobs.getActive();
}

export function waitForProviderLimitsRefreshJob(jobId: string) {
  return providerLimitsRefreshJobs.wait(jobId);
}
