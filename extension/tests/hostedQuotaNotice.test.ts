import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_QUOTA_NOTIFICATION_ID, notifyHostedQuotaExhausted, notifyHostedQuotaLow, openHostedQuotaNotice } from "../src/lib/hostedQuotaNotice";
import type { ManagedEntitlements } from "../src/types";

const entitlements: ManagedEntitlements = {
  planLabel: "Hosted Pro",
  plan: "hosted_pro",
  status: "active",
  used: 240,
  limit: 300,
  remaining: 60,
  warning: "low",
  audio: { remainingSeconds: 59, warning: "none" },
  canProcess: true,
  inPaymentGrace: false,
};

describe("Hosted quota notice", () => {
  const create = vi.fn();
  const clear = vi.fn();

  beforeEach(() => {
    create.mockReset();
    clear.mockReset();
  });

  afterEach(() => {
    delete (chrome as unknown as { notifications?: unknown }).notifications;
    vi.restoreAllMocks();
  });

  it("notifies when a Hosted recording starts near the plan limit", () => {
    Object.defineProperty(chrome, "notifications", { configurable: true, value: { create, clear } });
    notifyHostedQuotaLow(entitlements);
    expect(create).toHaveBeenCalledWith(HOSTED_QUOTA_NOTIFICATION_ID, expect.objectContaining({
      title: "Hosted AI allowance is running low",
      message: expect.stringContaining("less than 1m audio remain"),
      buttons: [{ title: "Review settings" }],
    }));
  });

  it("does not notify while both allowances are healthy", () => {
    Object.defineProperty(chrome, "notifications", { configurable: true, value: { create, clear } });
    notifyHostedQuotaLow({ ...entitlements, warning: "none", audio: { remainingSeconds: 10_000, warning: "none" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("alerts if a shared Hosted allowance is exhausted after a recording", () => {
    Object.defineProperty(chrome, "notifications", { configurable: true, value: { create, clear } });
    notifyHostedQuotaExhausted();
    expect(create).toHaveBeenCalledWith(HOSTED_QUOTA_NOTIFICATION_ID, expect.objectContaining({
      title: "Hosted AI allowance is exhausted",
      message: expect.stringContaining("Your recording is saved on this device"),
    }));
  });

  it("opens settings only for its own notification", async () => {
    const openOptionsPage = vi.spyOn(chrome.runtime, "openOptionsPage").mockResolvedValue(undefined);
    Object.defineProperty(chrome, "notifications", { configurable: true, value: { create, clear } });
    await expect(openHostedQuotaNotice("other-notification")).resolves.toBe(false);
    await expect(openHostedQuotaNotice(HOSTED_QUOTA_NOTIFICATION_ID)).resolves.toBe(true);
    expect(clear).toHaveBeenCalledWith(HOSTED_QUOTA_NOTIFICATION_ID);
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
