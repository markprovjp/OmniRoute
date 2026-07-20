import { expect, test } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

const connections = Array.from({ length: 3 }, (_, index) => ({
  id: `quota-connection-${index + 1}`,
  provider: "codex",
  authType: "oauth",
  name: `Quota account ${index + 1}`,
  displayName: `Quota account ${index + 1}`,
  email: `quota-${index + 1}@example.test`,
  providerSpecificData: { plan: "plus" },
  quotaWindowThresholds: null,
}));

function cache(used: number) {
  return {
    quotas: { session: { used, total: 10, resetAt: null } },
    plan: "plus",
    message: null,
    fetchedAt: "2026-07-20T00:00:00.000Z",
    source: "manual",
  };
}

test("Refresh All keeps cached quotas visible and applies job updates progressively", async ({
  page,
}) => {
  let poll = 0;
  await page.route("**/api/providers/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections }),
    })
  );
  await page.route("**/api/usage/provider-limits", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        caches: Object.fromEntries(connections.map((connection) => [connection.id, cache(9)])),
      }),
    });
  });
  await page.route("**/api/usage/provider-limits/jobs", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ job: null }),
      });
    }
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        deduplicated: false,
        job: {
          id: "quota-job-1",
          state: "running",
          total: 3,
          completed: 0,
          succeeded: 0,
          failed: 0,
          cursor: 0,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: null,
          error: null,
        },
      }),
    });
  });
  await page.route("**/api/usage/provider-limits/jobs/quota-job-1?after=*", async (route) => {
    poll += 1;
    if (poll === 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const completed = Math.min(poll, 3);
    const connection = connections[completed - 1];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "quota-job-1",
          state: completed === 3 ? "completed" : "running",
          total: 3,
          completed,
          succeeded: completed,
          failed: 0,
          cursor: completed,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: completed === 3 ? "2026-07-20T00:00:03.000Z" : null,
          error: null,
        },
        updates: [
          {
            sequence: completed,
            connectionId: connection.id,
            provider: connection.provider,
            status: "succeeded",
            cache: cache(1),
          },
        ],
      }),
    });
  });

  await gotoDashboardRoute(page, "/dashboard/quota", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Quota account 1", { exact: true })).toBeVisible();
  await expect(page.getByText("10%", { exact: true }).first()).toBeVisible();

  const refresh = page.getByRole("button", { name: /refresh all|làm mới tất cả/i });
  await refresh.click();

  await expect(page.getByText(/1\s*\/\s*3/)).toBeVisible();
  await expect(page.getByText("90%", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("10%", { exact: true }).first()).toBeVisible();

  await expect(refresh).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByText("10%", { exact: true })).toHaveCount(0);
});

test("Provider Limits reattaches to an active refresh job after page load", async ({ page }) => {
  const connection = connections[0];
  await page.route("**/api/providers/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections: [connection] }),
    })
  );
  await page.route("**/api/usage/provider-limits", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ caches: { [connection.id]: cache(9) } }),
    });
  });
  await page.route("**/api/usage/provider-limits/jobs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "reattach-job",
          state: "running",
          total: 1,
          completed: 0,
          succeeded: 0,
          failed: 0,
          cursor: 0,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: null,
          error: null,
        },
      }),
    })
  );
  await page.route("**/api/usage/provider-limits/jobs/reattach-job?after=*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "reattach-job",
          state: "completed",
          total: 1,
          completed: 1,
          succeeded: 1,
          failed: 0,
          cursor: 1,
          startedAt: "2026-07-20T00:00:00.000Z",
          completedAt: "2026-07-20T00:00:01.000Z",
          error: null,
        },
        updates: [
          {
            sequence: 1,
            connectionId: connection.id,
            provider: connection.provider,
            status: "succeeded",
            cache: cache(1),
          },
        ],
      }),
    })
  );

  await gotoDashboardRoute(page, "/dashboard/quota", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("90%", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("Provider Limits renders at most 100 account rows per page", async ({ page }) => {
  const manyConnections = Array.from({ length: 250 }, (_, index) => ({
    id: `paged-connection-${index + 1}`,
    provider: "codex",
    authType: "oauth",
    name: `Paged account ${String(index + 1).padStart(3, "0")}`,
    displayName: `Paged account ${String(index + 1).padStart(3, "0")}`,
    email: `paged-${index + 1}@example.test`,
    providerSpecificData: { plan: "plus" },
    quotaWindowThresholds: null,
  }));

  await page.route("**/api/providers/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections: manyConnections }),
    })
  );
  await page.route("**/api/usage/provider-limits", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        caches: Object.fromEntries(manyConnections.map((connection) => [connection.id, cache(5)])),
      }),
    });
  });

  await gotoDashboardRoute(page, "/dashboard/quota", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("provider-limit-row")).toHaveCount(100);
  await expect(page.getByText(/page 1 of 3|trang 1 \/ 3/i)).toBeVisible();

  await page.getByRole("button", { name: /next page|trang sau/i }).click();
  await expect(page.getByTestId("provider-limit-row")).toHaveCount(100);
  await expect(page.getByText(/page 2 of 3|trang 2 \/ 3/i)).toBeVisible();

  await page.getByRole("button", { name: /next page|trang sau/i }).click();
  await expect(page.getByTestId("provider-limit-row")).toHaveCount(50);
  await expect(page.getByText(/page 3 of 3|trang 3 \/ 3/i)).toBeVisible();
});
