import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-job-route-"));
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.INITIAL_PASSWORD = "quota-job-route-password";
process.env.OMNIROUTE_API_KEY = "quota-job-management-key";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const postRoute = await import("../../src/app/api/usage/provider-limits/jobs/route.ts");
const getRoute = await import("../../src/app/api/usage/provider-limits/jobs/[jobId]/route.ts");

function managementRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.OMNIROUTE_API_KEY}`,
      ...init.headers,
    },
  });
}

test.after(async () => {
  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  closeDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("provider limits refresh job POST requires management auth", async () => {
  const response = await postRoute.POST(
    new Request("http://localhost/api/usage/provider-limits/jobs", { method: "POST" })
  );
  assert.equal(response.status, 401);
});

test("provider limits refresh jobs collection exposes the active job without starting another", async () => {
  const response = await postRoute.GET(
    managementRequest("http://localhost/api/usage/provider-limits/jobs")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.job, null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("provider limits refresh job routes expose a 202 job and cursor progress", async () => {
  const response = await postRoute.POST(
    managementRequest("http://localhost/api/usage/provider-limits/jobs", { method: "POST" })
  );
  const body = (await response.json()) as { job: { id: string; total: number } };

  assert.equal(response.status, 202);
  assert.equal(typeof body.job.id, "string");
  assert.equal(body.job.total, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const progress = await getRoute.GET(
    managementRequest(`http://localhost/api/usage/provider-limits/jobs/${body.job.id}?after=0`),
    { params: Promise.resolve({ jobId: body.job.id }) }
  );
  const progressBody = await progress.json();
  assert.equal(progress.status, 200);
  assert.deepEqual(progressBody.updates, []);
  assert.doesNotMatch(
    JSON.stringify(progressBody),
    /accessToken|refreshToken|apiKey|credentials|stack/i
  );
});

test("provider limits refresh job GET validates cursor and unknown jobs", async () => {
  const invalid = await getRoute.GET(
    managementRequest("http://localhost/api/usage/provider-limits/jobs/missing?after=-1"),
    { params: Promise.resolve({ jobId: "missing" }) }
  );
  assert.equal(invalid.status, 400);

  const missing = await getRoute.GET(
    managementRequest("http://localhost/api/usage/provider-limits/jobs/missing?after=0"),
    { params: Promise.resolve({ jobId: "missing" }) }
  );
  assert.equal(missing.status, 404);
});
