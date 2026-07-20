import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const schedulerSource = fs.readFileSync(
  new URL("../../src/shared/services/providerLimitsSyncScheduler.ts", import.meta.url),
  "utf8"
);

test("scheduled provider limits sync joins the shared refresh job coordinator", () => {
  assert.match(schedulerSource, /startProviderLimitsRefreshJob/);
  assert.match(schedulerSource, /waitForProviderLimitsRefreshJob/);
  assert.doesNotMatch(schedulerSource, /syncAllProviderLimits/);
  assert.doesNotMatch(schedulerSource, /let isRunning\s*=/);
});
