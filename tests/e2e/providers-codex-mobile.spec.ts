import { expect, test } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

const connections = [
  {
    id: "codex-mobile-1",
    provider: "codex",
    name: "mobile-codex-1@example.com",
    email: "mobile-codex-1@example.com",
    authType: "oauth",
    isActive: true,
    priority: 1,
    rateLimitProtection: false,
    testStatus: "active",
    providerSpecificData: { codexLimitPolicy: { use5h: true, useWeekly: true } },
  },
  {
    id: "codex-mobile-2",
    provider: "codex",
    name: "mobile-codex-2@example.com",
    email: "mobile-codex-2@example.com",
    authType: "oauth",
    isActive: true,
    priority: 2,
    rateLimitProtection: true,
    testStatus: "active",
    providerSpecificData: { codexLimitPolicy: { use5h: true, useWeekly: true } },
  },
];

test("Codex connection controls remain usable without horizontal overflow on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.route("**/api/providers", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections }),
    });
  });

  await gotoDashboardRoute(page, "/dashboard/providers/codex");
  await expect(page.getByText("2 accounts")).toBeVisible();

  const firstRow = page.getByTestId("connection-row-codex-mobile-1");
  await expect(firstRow).toBeVisible();
  await expect(firstRow.getByText(/5h/)).toBeVisible();
  await expect(firstRow.getByText(/Weekly/)).toBeVisible();

  for (const width of [320, 360, 390, 414, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-testid="connection-row-codex-mobile-1"]'
      );
      if (!row) throw new Error("Codex connection row was not rendered");
      const rowRect = row.getBoundingClientRect();
      const overflowingDescendants = Array.from(row.querySelectorAll<HTMLElement>("*"))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(
          ({ rect }) =>
            rect.width > 0 && (rect.left < rowRect.left - 1 || rect.right > rowRect.right + 1)
        )
        .map(({ element, rect }) => ({
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        }));

      return {
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        rowWidth: Math.round(rowRect.width),
        overflowingDescendants,
      };
    });

    expect(layout.documentOverflow, `document overflow at ${width}px`).toBeLessThanOrEqual(1);
    expect(layout.rowWidth, `row width at ${width}px`).toBeGreaterThan(200);
    expect(layout.overflowingDescendants, `row overflow at ${width}px`).toEqual([]);
  }

  await page.setViewportSize({ width: 360, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("codex-provider-mobile-360.png"),
    fullPage: true,
  });
});
