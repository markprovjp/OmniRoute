import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-credit-ledger-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";
process.env.INITIAL_PASSWORD = "bootstrap-password";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const localDb = await import("../../src/lib/localDb.ts");
const keyRoute = await import("../../src/app/api/keys/[id]/route.ts");
const creditsRoute = await import("../../src/app/api/keys/[id]/credits/route.ts");
const creditRoute = await import("../../src/app/api/keys/[id]/credits/[creditId]/route.ts");
const { PREPAID_TOKEN_PACKAGES } = await import("../../src/shared/constants/apiKeyBilling.ts");

const MACHINE_ID = "1234567890abcdef";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await localDb.updateSettings({ requireLogin: true, password: "" });
  await apiKeysDb.createApiKey("management", MACHINE_ID);
}

async function createCustomerKey() {
  return apiKeysDb.createApiKey("Customer A", MACHINE_ID, {
    customerName: "Customer A",
    commercialKey: true,
    tokenLimit: 200_000_000,
  });
}

async function managementRequest(url: string, init: { method?: string; body?: unknown } = {}) {
  return makeManagementSessionRequest(url, init);
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("15M test-credit package is available", () => {
  assert.ok(PREPAID_TOKEN_PACKAGES.includes(15_000_000 as never));
});

test("unpaid top-up atomically increases lifetime limit and creates collectible VND debt", async () => {
  const customer = await createCustomerKey();
  apiKeysDb.incrementApiKeyTokenUsage(customer.id, 188_000_000);

  const response = await creditsRoute.POST(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`, {
      method: "POST",
      body: {
        tokenAmount: 200_000_000,
        amountDueVnd: 2_000_000,
        paymentStatus: "unpaid",
        applyTokens: true,
        note: "Top-up before bank transfer",
      },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const payload = (await response.json()) as any;
  const storedKey = await apiKeysDb.getApiKeyById(customer.id);

  assert.equal(response.status, 201);
  assert.equal(storedKey?.tokenLimit, 400_000_000);
  assert.equal(payload.credit.tokenAmount, 200_000_000);
  assert.equal(payload.credit.amountDueVnd, 2_000_000);
  assert.equal(payload.credit.status, "unpaid");
  assert.equal(payload.summary.outstandingAmountVnd, 2_000_000);
  assert.equal(payload.summary.outstandingTokenAmount, 200_000_000);
});

test("record-only debt preserves an already adjusted token limit", async () => {
  const customer = await createCustomerKey();

  const response = await creditsRoute.POST(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`, {
      method: "POST",
      body: {
        tokenAmount: 200_000_000,
        amountDueVnd: 1_500_000,
        paymentStatus: "unpaid",
        applyTokens: false,
      },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const storedKey = await apiKeysDb.getApiKeyById(customer.id);

  assert.equal(response.status, 201);
  assert.equal(storedKey?.tokenLimit, 200_000_000);
});

test("bank transfer clears outstanding debt without deleting ledger history", async () => {
  const customer = await createCustomerKey();
  const createResponse = await creditsRoute.POST(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`, {
      method: "POST",
      body: {
        tokenAmount: 200_000_000,
        amountDueVnd: 2_000_000,
        paymentStatus: "unpaid",
        applyTokens: true,
      },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const created = (await createResponse.json()) as any;

  const paymentResponse = await creditRoute.PATCH(
    await managementRequest(
      `http://localhost/api/keys/${customer.id}/credits/${created.credit.id}`,
      {
        method: "PATCH",
        body: { action: "mark_paid" },
      }
    ),
    { params: Promise.resolve({ id: customer.id, creditId: created.credit.id }) }
  );
  const payment = (await paymentResponse.json()) as any;

  const listResponse = await creditsRoute.GET(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const list = (await listResponse.json()) as any;

  assert.equal(paymentResponse.status, 200);
  assert.equal(payment.credit.status, "paid");
  assert.equal(payment.credit.amountPaidVnd, 2_000_000);
  assert.equal(payment.summary.outstandingAmountVnd, 0);
  assert.equal(list.credits.length, 1);
  assert.equal(list.credits[0].status, "paid");
  assert.ok(list.credits[0].paidAt);
});

test("15M test credit is free and cannot create debt", async () => {
  const customer = await createCustomerKey();
  const response = await creditsRoute.POST(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`, {
      method: "POST",
      body: {
        tokenAmount: 15_000_000,
        amountDueVnd: 1,
        paymentStatus: "unpaid",
        applyTokens: true,
        kind: "test_credit",
      },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const payload = (await response.json()) as any;

  assert.equal(response.status, 201);
  assert.equal(payload.credit.amountDueVnd, 0);
  assert.equal(payload.credit.status, "waived");
});

test("generic key PATCH cannot increase lifetime tokens without a ledger entry", async () => {
  const customer = await createCustomerKey();
  const response = await keyRoute.PATCH(
    await managementRequest(`http://localhost/api/keys/${customer.id}`, {
      method: "PATCH",
      body: { tokenLimit: 400_000_000 },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );
  const payload = (await response.json()) as any;

  assert.equal(response.status, 409);
  assert.match(payload.error, /token top-up/i);
  assert.equal((await apiKeysDb.getApiKeyById(customer.id))?.tokenLimit, 200_000_000);
});

test("credit routes reject invalid financial values", async () => {
  const customer = await createCustomerKey();
  const response = await creditsRoute.POST(
    await managementRequest(`http://localhost/api/keys/${customer.id}/credits`, {
      method: "POST",
      body: {
        tokenAmount: -1,
        amountDueVnd: -100,
        paymentStatus: "unpaid",
        applyTokens: true,
      },
    }),
    { params: Promise.resolve({ id: customer.id }) }
  );

  assert.equal(response.status, 400);
});
