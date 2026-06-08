import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  OMNIROUTE_DISABLE_BACKGROUND_SERVICES: process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES,
  OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE: process.env.OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE,
  OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS: process.env.OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS,
};

const maintenance = await import("../../src/lib/jobs/runtimeMaintenanceJob.ts");

afterEach(() => {
  maintenance.stopRuntimeMaintenanceJob();

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("runtime maintenance interval defaults to hourly and clamps tiny values", () => {
  delete process.env.OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS;
  assert.equal(maintenance.getRuntimeMaintenanceIntervalMs(), 3_600_000);

  process.env.OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS = "1000";
  assert.equal(maintenance.getRuntimeMaintenanceIntervalMs(), 60_000);

  process.env.OMNIROUTE_RUNTIME_MAINTENANCE_INTERVAL_MS = "120000";
  assert.equal(maintenance.getRuntimeMaintenanceIntervalMs(), 120_000);
});

test("runtime maintenance respects background-service and test-mode disable flags", () => {
  process.env.NODE_ENV = "development";
  delete process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES;
  delete process.env.OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE;
  assert.equal(maintenance.isRuntimeMaintenanceDisabled(), false);

  process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
  assert.equal(maintenance.isRuntimeMaintenanceDisabled(), true);

  process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "false";
  process.env.OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE = "1";
  assert.equal(maintenance.isRuntimeMaintenanceDisabled(), true);

  process.env.OMNIROUTE_DISABLE_RUNTIME_MAINTENANCE = "0";
  process.env.NODE_ENV = "test";
  assert.equal(maintenance.isRuntimeMaintenanceDisabled(), true);
});
