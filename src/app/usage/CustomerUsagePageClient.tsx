"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Gauge,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";

const TELEGRAM_BOT_URL_PREFIX = "https://t.me/qrouter_token_bot?start=";

type UsageMetric = {
  limit: number | null;
  used: number;
  remaining: number | null;
  resetAt?: string | null;
};

type CustomerUsageResponse = {
  success: boolean;
  checkedAt: string;
  key: {
    name: string;
    prefix: string;
    state: string;
    expires_at: string | null;
  };
  requests: {
    today: number;
    hour: number;
    total: number;
    limit: number | null;
    remaining: number | null;
    reset_at: string;
  };
  tokens: {
    today: number;
    hour: number;
    total: number;
    input: number;
    output: number;
    limit: number | null;
    remaining: number | null;
    daily_limit: number | null;
    daily_remaining: number | null;
    hourly_limit: number | null;
    hourly_remaining: number | null;
    reset_at: string;
  };
  requestQuota: UsageMetric;
  tokenQuota: UsageMetric & { reserved?: number; effectiveUsed?: number };
  alerts?: Array<{
    id: string;
    metric: "daily_tokens" | "lifetime_tokens" | "key_expiry";
    level: "warning" | "critical" | "exhausted";
    thresholdPercent: number | null;
    usedPercent: number | null;
    title: string;
    message: string;
    resetAt: string | null;
    expiresAt?: string | null;
  }>;
  quotaUsage?: {
    totalTokenUsed: number;
    lifetimeTokenUsed: number;
    dailyTokenUsed: number;
    dailyReservedTokens: number;
    hourlyTokenUsed: number;
    hourlyReservedTokens: number;
  };
  models: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    last_used_at: string | null;
  }>;
};

type CustomerRequestLog = {
  id: string;
  timestamp: string | null;
  method: string | null;
  path: string | null;
  status: number;
  outcome: "success" | "error";
  model: string;
  requestType: string | null;
  durationMs: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    reasoning: number | null;
    compressed: number | null;
    total: number;
  };
  cacheSource: string;
  error: string | null;
};

type CustomerLogsResponse = {
  success: boolean;
  checkedAt: string;
  logs: CustomerRequestLog[];
  summary: {
    returned: number;
    errors: number;
    averageLatencyMs: number | null;
  };
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unlimited";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "No reset";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "No reset";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function quotaPercent(metric: UsageMetric): number | null {
  if (!metric.limit || metric.limit <= 0) return null;
  return Math.max(0, Math.min(100, (metric.used / metric.limit) * 100));
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-h-28 rounded-lg border border-border bg-surface p-4 shadow-soft">
      <div className="text-sm text-text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-text-main">{value}</div>
      <div className="mt-1 text-sm text-text-muted">{sub}</div>
    </div>
  );
}

function QuotaBar({ label, metric }: { label: string; metric: UsageMetric }) {
  const percent = quotaPercent(metric);
  const width = `${percent ?? 0}%`;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-soft">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium text-text-main">{label}</div>
          <div className="mt-1 text-sm text-text-muted">Reset {formatDate(metric.resetAt)}</div>
        </div>
        <div className="text-right text-sm text-text-muted">
          <div>{formatNumber(metric.used)} used</div>
          <div>{formatNumber(metric.remaining)} left</div>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg-subtle">
        <div className="h-full rounded-full bg-primary" style={{ width }} />
      </div>
      <div className="mt-2 text-xs text-text-muted">
        Limit {formatNumber(metric.limit)}
        {percent === null ? "" : ` · ${Math.round(percent)}% used`}
      </div>
    </div>
  );
}

function AlertCard({
  title,
  message,
  tone,
  meta,
}: {
  title: string;
  message: string;
  tone: "warning" | "critical" | "exhausted";
  meta: string;
}) {
  const className =
    tone === "exhausted"
      ? "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300"
      : tone === "critical"
        ? "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:text-orange-300"
        : "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300";

  return (
    <div className={`rounded-lg border px-4 py-3 ${className}`}>
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <div className="font-medium">{title}</div>
          <div className="mt-1 text-sm">{message}</div>
          <div className="mt-2 text-xs opacity-80">{meta}</div>
        </div>
      </div>
    </div>
  );
}

export default function CustomerUsagePageClient() {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<CustomerUsageResponse | null>(null);
  const [logs, setLogs] = useState<CustomerLogsResponse | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [lookedUpApiKey, setLookedUpApiKey] = useState<string | null>(null);
  const [telegramLinkStatus, setTelegramLinkStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [telegramDeepLink, setTelegramDeepLink] = useState<string | null>(null);
  const lookupSequence = useRef(0);

  const keyStateClass = useMemo(() => {
    if (!usage) return "bg-bg-subtle text-text-muted";
    return usage.key.state === "active"
      ? "bg-green-500/10 text-green-600 dark:text-green-400"
      : "bg-red-500/10 text-red-600 dark:text-red-400";
  }, [usage]);

  function handleApiKeyChange(value: string) {
    // A displayed usage result is valid only for the exact key that was checked.
    lookupSequence.current += 1;
    setApiKey(value);
    setLoading(false);
    setError(null);
    setUsage(null);
    setLogs(null);
    setLogsError(null);
    setLookedUpApiKey(null);
    setTelegramLinkStatus("idle");
    setTelegramDeepLink(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) {
      setError("Enter a share key first.");
      setUsage(null);
      setLogs(null);
      setLookedUpApiKey(null);
      return;
    }

    const requestId = ++lookupSequence.current;
    setLoading(true);
    setError(null);
    setUsage(null);
    setLogs(null);
    setLogsError(null);
    setLookedUpApiKey(null);
    setTelegramLinkStatus("idle");
    setTelegramDeepLink(null);
    try {
      const [response, logsResponse] = await Promise.all([
        fetch("/api/customer/usage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: key }),
        }),
        fetch("/api/customer/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: key, limit: 50 }),
        }),
      ]);
      const body = await response.json();
      if (lookupSequence.current !== requestId) return;
      if (!response.ok) {
        throw new Error(body?.error || body?.message || "Key check failed.");
      }

      setUsage(body as CustomerUsageResponse);
      setLookedUpApiKey(key);
      const logsBody = await logsResponse.json();
      if (lookupSequence.current !== requestId) return;
      if (logsResponse.ok) {
        setLogs(logsBody as CustomerLogsResponse);
      } else {
        setLogs(null);
        setLogsError(logsBody?.error || logsBody?.message || "Could not load request logs.");
      }
    } catch (err) {
      if (lookupSequence.current !== requestId) return;
      setUsage(null);
      setLogs(null);
      setLookedUpApiKey(null);
      setError(err instanceof Error ? err.message : "Key check failed.");
    } finally {
      if (lookupSequence.current === requestId) setLoading(false);
    }
  }

  async function connectTelegramAlerts() {
    if (telegramLinkStatus === "loading") return;

    const key = lookedUpApiKey;
    if (!key) return;

    setTelegramLinkStatus("loading");
    setTelegramDeepLink(null);
    try {
      const response = await fetch("/api/customer/telegram-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error("Telegram link request failed.");

      const deepLink = typeof body?.deepLink === "string" ? body.deepLink : "";
      if (!deepLink.startsWith(TELEGRAM_BOT_URL_PREFIX)) {
        throw new Error("Telegram link response was invalid.");
      }

      setTelegramDeepLink(deepLink);
      setTelegramLinkStatus("ready");
    } catch {
      setTelegramLinkStatus("error");
    }
  }

  return (
    <main id="main-content" className="min-h-screen bg-bg px-4 py-6 text-text-main sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <section className="rounded-lg border border-border bg-surface p-5 shadow-soft sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <Gauge className="h-4 w-4" aria-hidden="true" />
                QRouter customer
              </div>
              <h1 className="mt-2 text-2xl font-semibold text-text-main sm:text-3xl">
                Usage check
              </h1>
            </div>
            {usage ? (
              <div
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${keyStateClass}`}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {usage.key.state}
              </div>
            ) : null}
          </div>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-3 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Share key</span>
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
              <input
                value={apiKey}
                onChange={(event) => handleApiKeyChange(event.target.value)}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="qrouter_sk_..."
                className="h-12 w-full rounded-lg border border-border bg-bg px-10 text-base text-text-main outline-none transition focus:border-primary"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              Check
            </button>
          </form>

          {error ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : null}
        </section>

        {usage && lookedUpApiKey ? (
          <>
            {usage.alerts && usage.alerts.length > 0 ? (
              <section className="grid gap-3">
                {usage.alerts.map((alert) => (
                  <AlertCard
                    key={alert.id}
                    title={alert.title}
                    message={alert.message}
                    tone={alert.level}
                    meta={
                      alert.metric === "key_expiry"
                        ? `Expires ${formatDate(alert.expiresAt ?? null)}`
                        : `Reset ${formatDate(alert.resetAt)}`
                    }
                  />
                ))}
              </section>
            ) : null}

            <section className="rounded-lg border border-border bg-surface p-4 shadow-soft">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2 text-primary">
                    <Send className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="font-medium text-text-main">Telegram alerts</div>
                    <p className="mt-1 text-sm text-text-muted">
                      Get alerts at 90%, 95%, and 100% quota use, plus before your key expires.
                    </p>
                    {telegramLinkStatus === "error" ? (
                      <p
                        className="mt-2 text-sm text-red-600 dark:text-red-400"
                        role="status"
                        aria-live="polite"
                      >
                        Unable to connect Telegram alerts.
                      </p>
                    ) : null}
                    {telegramLinkStatus === "ready" ? (
                      <p
                        className="mt-2 text-sm text-green-600 dark:text-green-400"
                        role="status"
                        aria-live="polite"
                      >
                        Telegram link is ready. Open Telegram to finish connecting.
                      </p>
                    ) : null}
                  </div>
                </div>
                {telegramLinkStatus === "ready" && telegramDeepLink ? (
                  <a
                    href={telegramDeepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 text-sm font-semibold text-white outline-none transition hover:bg-green-700 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-[0.98]"
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Open Telegram
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={connectTelegramAlerts}
                    disabled={telegramLinkStatus === "loading"}
                    className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 ${
                      telegramLinkStatus === "error"
                        ? "border border-red-500/30 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300"
                        : "bg-primary text-white hover:bg-primary-hover"
                    }`}
                  >
                    {telegramLinkStatus === "loading" ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="h-4 w-4" aria-hidden="true" />
                    )}
                    {telegramLinkStatus === "loading" ? "Connecting..." : "Connect Telegram alerts"}
                  </button>
                )}
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile
                label="Key"
                value={usage.key.prefix}
                sub={usage.key.name || "Customer key"}
              />
              <MetricTile
                label="Requests today"
                value={formatNumber(usage.requests.today)}
                sub={`${formatNumber(usage.requests.remaining)} remaining`}
              />
              <MetricTile
                label="Tokens today"
                value={formatNumber(usage.tokens.today)}
                sub={`${formatNumber(usage.tokens.daily_remaining)} remaining`}
              />
              <MetricTile
                label="Quota used total"
                value={formatNumber(usage.quotaUsage?.totalTokenUsed ?? usage.tokens.total)}
                sub={`${formatNumber(usage.tokens.total)} lifetime tokens`}
              />
            </section>

            <section className="grid gap-3 rounded-lg border border-border bg-surface p-4 text-sm shadow-soft sm:grid-cols-3">
              <div>
                <div className="text-text-muted">Lifetime used</div>
                <div className="mt-1 font-semibold text-text-main">
                  {formatNumber(usage.quotaUsage?.lifetimeTokenUsed ?? usage.tokens.total)}
                </div>
              </div>
              <div>
                <div className="text-text-muted">Daily quota used</div>
                <div className="mt-1 font-semibold text-text-main">
                  {formatNumber(
                    (usage.quotaUsage?.dailyTokenUsed ?? usage.tokens.today) +
                      (usage.quotaUsage?.dailyReservedTokens ?? 0)
                  )}
                </div>
              </div>
              <div>
                <div className="text-text-muted">Hourly quota used</div>
                <div className="mt-1 font-semibold text-text-main">
                  {formatNumber(
                    (usage.quotaUsage?.hourlyTokenUsed ?? usage.tokens.hour) +
                      (usage.quotaUsage?.hourlyReservedTokens ?? 0)
                  )}
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <QuotaBar label="Request quota" metric={usage.requestQuota} />
              <QuotaBar label="Token quota" metric={usage.tokenQuota} />
            </section>

            {usage.models.length > 0 ? (
              <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-soft">
                <div className="border-b border-border px-4 py-3 font-medium text-text-main">
                  Model usage
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left text-sm">
                    <thead className="bg-bg-subtle text-text-muted">
                      <tr>
                        <th className="px-4 py-3 font-medium">Model</th>
                        <th className="px-4 py-3 font-medium">Requests</th>
                        <th className="px-4 py-3 font-medium">Input</th>
                        <th className="px-4 py-3 font-medium">Output</th>
                        <th className="px-4 py-3 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.models.map((model) => (
                        <tr key={model.model} className="border-t border-border">
                          <td className="px-4 py-3 font-medium text-text-main">{model.model}</td>
                          <td className="px-4 py-3 text-text-muted">
                            {formatNumber(model.requests)}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {formatNumber(model.input_tokens)}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {formatNumber(model.output_tokens)}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {formatNumber(model.total_tokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-soft">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="font-medium text-text-main">Recent request logs</div>
                <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                  <span className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2.5 py-1">
                    <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                    Avg {formatLatency(logs?.summary.averageLatencyMs)}
                  </span>
                  <span className="rounded-full bg-bg-subtle px-2.5 py-1">
                    {formatNumber(logs?.summary.returned ?? 0)} shown
                  </span>
                  <span className="rounded-full bg-bg-subtle px-2.5 py-1">
                    {formatNumber(logs?.summary.errors ?? 0)} errors
                  </span>
                </div>
              </div>

              {logsError ? (
                <div className="m-4 flex items-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-300">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {logsError}
                </div>
              ) : null}

              {logs && logs.logs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="bg-bg-subtle text-text-muted">
                      <tr>
                        <th className="px-4 py-3 font-medium">Time</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Model</th>
                        <th className="px-4 py-3 font-medium">Route</th>
                        <th className="px-4 py-3 font-medium">Latency</th>
                        <th className="px-4 py-3 font-medium">Tokens</th>
                        <th className="px-4 py-3 font-medium">Cache</th>
                        <th className="px-4 py-3 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.logs.map((entry) => (
                        <tr key={entry.id} className="border-t border-border">
                          <td className="whitespace-nowrap px-4 py-3 text-text-muted">
                            {formatDate(entry.timestamp)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                                entry.outcome === "success"
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : "bg-red-500/10 text-red-600 dark:text-red-400"
                              }`}
                            >
                              {entry.status || "-"}
                            </span>
                          </td>
                          <td className="max-w-56 px-4 py-3 font-medium text-text-main">
                            <span className="block truncate">{entry.model}</span>
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            <div className="font-medium text-text-main">
                              {entry.method || "POST"} {entry.path || "/v1"}
                            </div>
                            <div className="text-xs">{entry.requestType || "request"}</div>
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {formatLatency(entry.durationMs)}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            <div>{formatNumber(entry.tokens.total)} total</div>
                            <div className="text-xs">
                              {formatNumber(entry.tokens.input)} in ·{" "}
                              {formatNumber(entry.tokens.output)} out
                            </div>
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            <div>{entry.cacheSource}</div>
                            <div className="text-xs">
                              read {formatNumber(entry.tokens.cacheRead ?? 0)}
                            </div>
                          </td>
                          <td className="max-w-64 px-4 py-3 text-text-muted">
                            <span className="block truncate">{entry.error || "-"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-text-muted">
                  No recent requests for this key.
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
