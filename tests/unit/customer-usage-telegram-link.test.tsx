// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerUsagePageClient from "../../src/app/usage/CustomerUsagePageClient";

const KEY_A = "qrouter_sk_checked_key_a";
const KEY_B = "qrouter_sk_edited_key_b";
const TELEGRAM_DEEP_LINK = "https://t.me/qrouter_token_bot?start=opaque-claim-token";

function response(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

const usageResponse = {
  success: true,
  checkedAt: "2026-07-20T00:00:00.000Z",
  key: { name: "Checked key", prefix: "qrouter_sk_checked", state: "active", expires_at: null },
  requests: { today: 1, hour: 1, total: 1, limit: 100, remaining: 99, reset_at: "" },
  tokens: {
    today: 1,
    hour: 1,
    total: 1,
    input: 1,
    output: 0,
    limit: 100,
    remaining: 99,
    daily_limit: 100,
    daily_remaining: 99,
    hourly_limit: 100,
    hourly_remaining: 99,
    reset_at: "",
  },
  requestQuota: { limit: 100, used: 1, remaining: 99 },
  tokenQuota: { limit: 100, used: 1, remaining: 99 },
  models: [],
};

const logsResponse = {
  success: true,
  checkedAt: "2026-07-20T00:00:00.000Z",
  logs: [],
  summary: { returned: 0, errors: 0, averageLatencyMs: null },
};

const cleanupCallbacks: Array<() => Promise<void>> = [];

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function findButton(container: HTMLElement, name: string) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(name)
  );
}

async function renderCheckedUsage(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  document.body.appendChild(container);
  cleanupCallbacks.push(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  await act(async () => {
    root.render(<CustomerUsagePageClient />);
  });
  const input = container.querySelector("input");
  const checkButton = findButton(container, "Check");
  if (!input || !checkButton) throw new Error("Usage form did not render.");

  await changeInput(input, KEY_A);
  await click(checkButton);
  return container;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    await cleanupCallbacks.pop()?.();
  }
  vi.unstubAllGlobals();
});

describe("customer usage Telegram alert linking", () => {
  it("invalidates usage and prevents claim issuance when the checked key is edited", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(usageResponse))
      .mockResolvedValueOnce(response(logsResponse));

    const container = await renderCheckedUsage(fetchMock);
    expect(container.textContent).toContain("qrouter_sk_checked");

    const input = container.querySelector("input");
    if (!input) throw new Error("Usage input did not render.");
    await changeInput(input, KEY_B);

    expect(container.textContent).not.toContain("qrouter_sk_checked");
    expect(findButton(container, "Connect Telegram alerts")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed Telegram deep links without rendering an activatable link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(usageResponse))
      .mockResolvedValueOnce(response(logsResponse))
      .mockResolvedValueOnce(response({ deepLink: "https://t.me/untrusted_bot?start=claim" }));

    const container = await renderCheckedUsage(fetchMock);
    const connectButton = findButton(container, "Connect Telegram alerts");
    if (!connectButton) throw new Error("Telegram button did not render.");
    await click(connectButton);

    expect(container.textContent).toContain("Unable to connect Telegram alerts.");
    expect(container.querySelector("a")).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/customer/telegram-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY_A }),
    });
  });

  it("renders a safe user-activated Telegram link only after a validated response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(usageResponse))
      .mockResolvedValueOnce(response(logsResponse))
      .mockResolvedValueOnce(response({ deepLink: TELEGRAM_DEEP_LINK }));

    const container = await renderCheckedUsage(fetchMock);
    const connectButton = findButton(container, "Connect Telegram alerts");
    if (!connectButton) throw new Error("Telegram button did not render.");
    await click(connectButton);

    const telegramLink = container.querySelector("a");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(
      "Telegram link is ready. Open Telegram to finish connecting."
    );
    expect(telegramLink?.textContent).toContain("Open Telegram");
    expect(telegramLink?.getAttribute("href")).toBe(TELEGRAM_DEEP_LINK);
    expect(telegramLink?.getAttribute("target")).toBe("_blank");
    expect(telegramLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(telegramLink?.getAttribute("href")).not.toContain(KEY_A);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
