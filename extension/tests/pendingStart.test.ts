import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingMeetStartFor, savePendingMeetStart, takePendingMeetStart } from "../src/meet/pendingStart";
import { chromeMock } from "./setup";

const KEY = "notetaker.pendingMeetStart";

beforeEach(() => {
  vi.restoreAllMocks();
  chromeMock.reset();
});

describe("pendingMeetStart", () => {
  it("saves a blocked widget start and hands it back exactly once", async () => {
    await savePendingMeetStart({ tabId: 9, meetingMode: "sales", titleHint: "Roadmap" });

    expect(chromeMock.storage.session._dump()[KEY]).toEqual({ tabId: 9, meetingMode: "sales", titleHint: "Roadmap" });
    expect(await takePendingMeetStart()).toEqual({ tabId: 9, meetingMode: "sales", titleHint: "Roadmap" });
    // Taken means taken: a second popup open must not auto-start again.
    expect(await takePendingMeetStart()).toBeNull();
  });

  it("retires the handoff for a tab once its capture started, leaving other tabs alone", async () => {
    await savePendingMeetStart({ tabId: 9, meetingMode: "sales" });

    await clearPendingMeetStartFor(7);
    expect(chromeMock.storage.session._dump()[KEY]).toEqual({ tabId: 9, meetingMode: "sales" });

    await clearPendingMeetStartFor(9);
    expect(chromeMock.storage.session._dump()[KEY]).toBeUndefined();
  });

  it("never returns a malformed entry", async () => {
    await new Promise<void>((resolve) => chromeMock.storage.session.set({ [KEY]: "nonsense" }, resolve));
    expect(await takePendingMeetStart()).toBeNull();
    // A malformed entry is discarded, not left behind to poison later opens.
    expect(chromeMock.storage.session._dump()[KEY]).toBeUndefined();
  });

  it("survives session storage being unavailable", async () => {
    chromeMock.storage.session.set.mockImplementation(() => {
      throw new Error("session storage unavailable");
    });
    await expect(savePendingMeetStart({ tabId: 9 })).resolves.toBeUndefined();
    await expect(takePendingMeetStart()).resolves.toBeNull();
    await expect(clearPendingMeetStartFor(9)).resolves.toBeUndefined();
  });
});