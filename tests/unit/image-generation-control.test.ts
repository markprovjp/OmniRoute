import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-image-control-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "image-control-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const imageControl = await import("../../src/lib/db/imageGenerationEvents.ts");

async function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createImageUser(name = "Image user") {
  return apiKeysDb.createApiKey(name, "image-control-machine");
}

function admissionInput(
  apiKey: { id: string; name: string },
  requestId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    requestId,
    operation: "generation" as const,
    provider: "openai",
    model: "openai/gpt-image-2",
    requestedCount: 1,
    size: "1024x1024",
    quality: "medium",
    outputFormat: "png",
    prompt: "A private prompt that must never be stored verbatim",
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("image admission stores attributable metadata without raw key, prompt, or image fields", async () => {
  const apiKey = await createImageUser("Attributable user");
  const admission = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_image_audit")
  );

  assert.equal(admission.allowed, true);
  const event = imageControl.getImageGenerationEventByRequestId("req_image_audit");
  assert.equal(event?.apiKeyId, apiKey.id);
  assert.equal(event?.apiKeyName, "Attributable user");
  assert.equal(event?.status, "running");
  assert.equal(event?.promptLength, 51);
  assert.match(event?.promptSha256 || "", /^[a-f0-9]{64}$/);
  assert.equal("prompt" in (event || {}), false);
  assert.equal("apiKey" in (event || {}), false);
  assert.equal("image" in (event || {}), false);

  const columns = core
    .getDbInstance()
    .prepare("PRAGMA table_info(image_generation_events)")
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  assert.equal(columnNames.has("prompt"), false);
  assert.equal(columnNames.has("api_key"), false);
  assert.equal(columnNames.has("image"), false);
});

test("image audit lifecycle records success, account attribution, and generated count", async () => {
  const apiKey = await createImageUser();
  const admission = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_image_success")
  );
  assert.equal(admission.allowed, true);
  if (!admission.allowed) return;

  imageControl.completeImageGenerationEvent({
    eventId: admission.eventId,
    status: "succeeded",
    httpStatus: 200,
    generatedCount: 1,
    connectionId: "connection-123",
    upstreamRequestId: "upstream-request-456",
    durationMs: 1234,
  });

  const event = imageControl.getImageGenerationEventByRequestId("req_image_success");
  assert.equal(event?.status, "succeeded");
  assert.equal(event?.httpStatus, 200);
  assert.equal(event?.generatedCount, 1);
  assert.equal(event?.connectionId, "connection-123");
  assert.equal(event?.upstreamRequestId, "upstream-request-456");
  assert.equal(event?.durationMs, 1234);
  assert.ok(event?.completedAt);
});

test("image admission enforces per-key enable, high-quality, and size policies", async () => {
  const apiKey = await createImageUser();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { imageGenerationEnabled: false });
  const disabled = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_image_disabled")
  );
  assert.deepEqual(
    { allowed: disabled.allowed, reason: disabled.allowed ? null : disabled.reason },
    { allowed: false, reason: "image_generation_disabled" }
  );

  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    imageGenerationEnabled: true,
    imageAllowHighQuality: false,
    imageAllowedSizes: ["1024x1024"],
  });
  const highQuality = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_image_high", { quality: "high" })
  );
  const wrongSize = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_image_size", { size: "1536x1024" })
  );

  assert.equal(highQuality.allowed, false);
  assert.equal(highQuality.allowed ? null : highQuality.reason, "image_high_quality_not_allowed");
  assert.equal(wrongSize.allowed, false);
  assert.equal(wrongSize.allowed ? null : wrongSize.reason, "image_size_not_allowed");
});

test("image admission atomically enforces per-key concurrency", async () => {
  const apiKey = await createImageUser();
  const first = imageControl.beginImageGenerationEvent(admissionInput(apiKey, "req_concurrent_1"));
  const second = imageControl.beginImageGenerationEvent(admissionInput(apiKey, "req_concurrent_2"));

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.allowed ? null : second.reason, "image_concurrency_key");
});

test("image admission enforces the per-minute accepted-request limit", async () => {
  const apiKey = await createImageUser();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    imageMaxRequestsPerMinute: 1,
    imageMaxConcurrent: 2,
  });
  const now = new Date("2026-07-20T10:00:00.000Z");
  const first = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_minute_1", { now })
  );
  assert.equal(first.allowed, true);
  if (first.allowed) {
    imageControl.completeImageGenerationEvent({
      eventId: first.eventId,
      status: "succeeded",
      httpStatus: 200,
      generatedCount: 1,
      durationMs: 10,
      now,
    });
  }

  const second = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_minute_2", { now: new Date(now.getTime() + 30_000) })
  );
  assert.equal(second.allowed, false);
  assert.equal(second.allowed ? null : second.reason, "image_rate_limit_minute");
});

test("image admission enforces the rolling 24-hour accepted-request limit", async () => {
  const apiKey = await createImageUser();
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    imageMaxRequestsPerMinute: 0,
    imageMaxRequestsPerDay: 1,
    imageMaxConcurrent: 2,
  });
  const now = new Date("2026-07-20T10:00:00.000Z");
  const first = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_day_1", { now })
  );
  assert.equal(first.allowed, true);
  if (first.allowed) {
    imageControl.completeImageGenerationEvent({
      eventId: first.eventId,
      status: "failed",
      httpStatus: 502,
      generatedCount: 0,
      errorCode: "upstream_error",
      durationMs: 10,
      now,
    });
  }

  const second = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_day_2", { now: new Date(now.getTime() + 3_600_000) })
  );
  assert.equal(second.allowed, false);
  assert.equal(second.allowed ? null : second.reason, "image_rate_limit_day");
});

test("image admission enforces the global concurrency limit", async () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  for (let index = 0; index < 8; index += 1) {
    const apiKey = await createImageUser(`Global user ${index}`);
    const admission = imageControl.beginImageGenerationEvent(
      admissionInput(apiKey, `req_global_${index}`, { now })
    );
    assert.equal(admission.allowed, true);
  }

  const blockedKey = await createImageUser("Global blocked user");
  const blocked = imageControl.beginImageGenerationEvent(
    admissionInput(blockedKey, "req_global_blocked", { now })
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? null : blocked.reason, "image_concurrency_global");
});

test("image admission reads IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT at runtime", async () => {
  const previous = process.env.IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT;
  process.env.IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT = "2";
  try {
    const now = new Date("2026-07-20T10:00:00.000Z");
    for (let index = 0; index < 2; index += 1) {
      const apiKey = await createImageUser(`Override user ${index}`);
      const admission = imageControl.beginImageGenerationEvent(
        admissionInput(apiKey, `req_override_${index}`, { now })
      );
      assert.equal(admission.allowed, true);
    }

    const blockedKey = await createImageUser("Override blocked user");
    const blocked = imageControl.beginImageGenerationEvent(
      admissionInput(blockedKey, "req_override_blocked", { now })
    );
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.allowed ? null : blocked.reason, "image_concurrency_global");
  } finally {
    if (previous === undefined) delete process.env.IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT;
    else process.env.IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT = previous;
  }
});

test("stale running image events expire and release concurrency", async () => {
  const apiKey = await createImageUser();
  const now = new Date("2026-07-20T10:00:00.000Z");
  const first = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_stale_1", { now })
  );
  assert.equal(first.allowed, true);

  const second = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_stale_2", { now: new Date(now.getTime() + 181_000) })
  );
  const expired = imageControl.getImageGenerationEventByRequestId("req_stale_1");

  assert.equal(second.allowed, true);
  assert.equal(expired?.status, "expired");
});

test("deleting an API key preserves its image audit identity snapshot", async () => {
  const apiKey = await createImageUser("Deleted image user");
  const admission = imageControl.beginImageGenerationEvent(
    admissionInput(apiKey, "req_deleted_key")
  );
  assert.equal(admission.allowed, true);

  await apiKeysDb.deleteApiKey(apiKey.id);
  const event = imageControl.getImageGenerationEventByRequestId("req_deleted_key");

  assert.equal(event?.apiKeyId, null);
  assert.equal(event?.apiKeyName, "Deleted image user");
});
