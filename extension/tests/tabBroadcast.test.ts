import { MEETING_TAB_PATTERNS } from "../src/meet/meetingSites";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { broadcastToMeetTabs } from "../src/meet/tabBroadcast";

beforeEach(() => {
  chromeMock.reset();
});

describe("broadcastToMeetTabs", () => {
  it("targets start failures and saved meeting details to their own tab", async () => {
    const send = vi.fn();
    Object.assign(chromeMock.tabs, { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]), sendMessage: send });
    await broadcastToMeetTabs({ type: "RECORDING_ERROR", meetingId: null, phase: "start", message: "Allow capture", tabId: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(2, expect.objectContaining({ type: "RECORDING_ERROR" }));
    send.mockClear();
    await broadcastToMeetTabs({ type: "SUMMARY_READY", meetingId: "m", summary: "private", actionItems: [] }, 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(1, expect.objectContaining({ type: "SUMMARY_READY" }));
    send.mockClear();
    await broadcastToMeetTabs({ type: "RECORDING_ERROR", meetingId: null, phase: "start", message: "Unscoped legacy error" });
    expect(send).not.toHaveBeenCalled();
  });
  it("sends to every Meet tab and tolerates tabs with no listener", async () => {
    const sendMessage = vi.fn(async (tabId: number) => {
      if (tabId === 2) throw new Error("Receiving end does not exist.");
    });
    Object.assign(chromeMock.tabs, {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]),
      sendMessage,
    });

    await expect(broadcastToMeetTabs({ type: "MEETING_STATE_CHANGED", meetingId: "m" })).resolves.toBeUndefined();

    expect(chromeMock.tabs).toHaveProperty("query");
    expect((chromeMock.tabs as unknown as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledWith({ url: MEETING_TAB_PATTERNS });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(1, { type: "MEETING_STATE_CHANGED", meetingId: "m" });
  });

  it("does nothing when tabs cannot be queried", async () => {
    Object.assign(chromeMock.tabs, { query: vi.fn(async () => { throw new Error("nope"); }), sendMessage: vi.fn() });
    await expect(broadcastToMeetTabs({ type: "HELPER_STATUS", status: "connected" })).resolves.toBeUndefined();
    expect((chromeMock.tabs as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled();
  });
});
