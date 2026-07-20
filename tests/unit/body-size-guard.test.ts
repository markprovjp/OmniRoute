import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES_AUDIO,
  MAX_BODY_BYTES,
  getBodySizeLimit,
  checkBodySize,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import {
  DEFAULT_REQUEST_BODY_LIMIT_MB,
  requestBodyLimitMbToBytes,
} from "../../src/shared/constants/bodySize.ts";

test("default request limit accepts multi-image payloads up to 200 MB", () => {
  assert.equal(DEFAULT_REQUEST_BODY_LIMIT_MB, 200);
  assert.equal(MAX_BODY_BYTES, requestBodyLimitMbToBytes(200));
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(requestBodyLimitMbToBytes(20)) },
  });

  assert.equal(checkBodySize(request), null);
});

test("body size guard uses maxBodySizeMb from settings for regular API routes", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});

test("body size guard keeps dedicated upload limits as lower bounds", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 1 }),
    MAX_BODY_BYTES_AUDIO
  );
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});

test("checkBodySize reports the configured request limit in 413 responses", async () => {
  const limit = requestBodyLimitMbToBytes(200);
  const request = new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(limit + 1) },
  });

  const response = checkBodySize(request, limit);

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /200 MB/);
});
