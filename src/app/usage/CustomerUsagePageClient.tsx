"use client";

import { FormEvent, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Gauge, KeyRound, Loader2, RefreshCw } from "lucide-react";

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
  models: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    last_used_at: string | null;
  }>;
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

export default function CustomerUsagePageClient() {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<CustomerUsageResponse | null>(null);

  const keyStateClass = useMemo(() => {
    if (!usage) return "bg-bg-subtle text-text-muted";
    return usage.key.state === "active"
      ? "bg-green-500/10 text-green-600 dark:text-green-400"
      : "bg-red-500/10 text-red-600 dark:text-red-400";
  }, [usage]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) {
      setError("Enter a share key first.");
      setUsage(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/customer/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || body?.message || "Key check failed.");
      }
      setUsage(body as CustomerUsageResponse);
    } catch (err) {
      setUsage(null);
      setError(err instanceof Error ? err.message : "Key check failed.");
    } finally {
      setLoading(false);
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
                onChange={(event) => setApiKey(event.target.value)}
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

        {usage ? (
          <>
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
                label="Total tokens"
                value={formatNumber(usage.tokens.total)}
                sub={`Checked ${formatDate(usage.checkedAt)}`}
              />
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
          </>
        ) : null}
      </div>
    </main>
  );
}
