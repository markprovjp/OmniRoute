import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-provider-limit-cache-route-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const providersDb = await import("../../src/lib/db/providers.ts");
const limitsDb = await import("../../src/lib/db/providerLimits.ts");
const route = await import("../../src/app/api/usage/provider-limits/route.ts");

const cache = {
  quotas: { session: { used: 1, total: 10 } },
  plan: "plus",
  message: null,
  fetchedAt: "2026-07-20T00:00:00.000Z",
  source: "manual",
};

test.after(async () => {
  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  closeDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("cached provider limits response excludes inactive and orphaned connections", async () => {
  const active = await providersDb.createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name: "active",
    apiKey: "active-test-key",
  });
  const inactive = await providersDb.createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name: "inactive",
    apiKey: "inactive-test-key",
    isActive: false,
  });
  limitsDb.setProviderLimitsCache(active.id, cache);
  limitsDb.setProviderLimitsCache(inactive.id, cache);
  limitsDb.setProviderLimitsCache("deleted-connection", cache);

  const response = await route.GET();
  const body = (await response.json()) as { caches: Record<string, unknown> };

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.caches), [active.id]);
});
