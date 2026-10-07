import { afterEach, describe, expect, it, vi } from "vitest";

const { findSubscription } = vi.hoisted(() => ({ findSubscription: vi.fn() }));
vi.mock("./db", () => ({ prisma: { workspaceSubscription: { findUnique: findSubscription } } }));

import { teamPlanActive } from "./teamAccess";

afterEach(() => {
  vi.unstubAllEnvs();
  findSubscription.mockReset();
});

describe("teamPlanActive", () => {
  it("requires an active Team plan on the managed service", async () => {
    vi.stubEnv("MANAGED_HOSTING", "true");
    findSubscription.mockResolvedValueOnce({ plan: "hosted_team", status: "active", graceEndsAt: null });
    expect(await teamPlanActive("w")).toBe(true);
    findSubscription.mockResolvedValueOnce({ plan: "hosted_pro", status: "active", graceEndsAt: null });
    expect(await teamPlanActive("w")).toBe(false);
    findSubscription.mockResolvedValueOnce(null);
    expect(await teamPlanActive("w")).toBe(false);
    findSubscription.mockResolvedValueOnce({ plan: "hosted_team", status: "canceled", graceEndsAt: null });
    expect(await teamPlanActive("w")).toBe(false);
  });

  it("does not gate a deployment without managed hosting", async () => {
    vi.stubEnv("MANAGED_HOSTING", "false");
    expect(await teamPlanActive("w")).toBe(true);
    expect(findSubscription).not.toHaveBeenCalled();
  });
});
