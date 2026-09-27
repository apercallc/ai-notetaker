import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { MEET_TAB_PATTERN, broadcastToMeetTabs } from "../src/meet/tabBroadcast";

beforeEach(() => {
  chromeMock.reset();
});

describe("broadcastToMeetTabs", () => {
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
    expect((chromeMock.tabs as unknown as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledWith({ url: MEET_TAB_PATTERN });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(1, { type: "MEETING_STATE_CHANGED", meetingId: "m" });
  });

  it("does nothing when tabs cannot be queried", async () => {
    Object.assign(chromeMock.tabs, { query: vi.fn(async () => { throw new Error("nope"); }), sendMessage: vi.fn() });
    await expect(broadcastToMeetTabs({ type: "HELPER_STATUS", status: "connected" })).resolves.toBeUndefined();
    expect((chromeMock.tabs as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled();
  });
});
