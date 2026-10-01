import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, retryMeetingProcessing } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  retryMeetingProcessing: vi.fn(),
}));

vi.mock("@/lib/currentUser", () => ({ requireSession }));
vi.mock("@/lib/meetingProcessing", () => ({ retryMeetingProcessing }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { retryProcessingAction } from "./actions";

const form = (meetingId: string) => {
  const data = new FormData();
  data.set("meetingId", meetingId);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ workspaceId: "ws-1", userId: "u1", role: "member" });
});

describe("retryProcessingAction", () => {
  it("returns a usable error instead of throwing when the retry blows up", async () => {
    retryMeetingProcessing.mockRejectedValue(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(retryProcessingAction(form("fails-1"))).resolves.toEqual({ status: "error", message: "Couldn't restart processing. Try again." });
    log.mockRestore();
  });

  it("allows a few retries a minute for one note, then asks the user to wait", async () => {
    retryMeetingProcessing.mockResolvedValue({ ok: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(retryProcessingAction(form("limited-1"))).resolves.toEqual({ status: "started" });
    }
    const blocked = await retryProcessingAction(form("limited-1"));
    expect(blocked).toMatchObject({ status: "error", message: expect.stringContaining("minute") });
    expect(retryMeetingProcessing).toHaveBeenCalledTimes(3);
    // A different note is unaffected.
    await expect(retryProcessingAction(form("other-note"))).resolves.toEqual({ status: "started" });
  });
});
