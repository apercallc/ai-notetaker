import { describe, expect, it } from "vitest";
import { isMessageAllowed } from "../src/lib/senderPolicy";

describe("Meet live transcript sender policy", () => {
  it("allows the offscreen capture page to report status and transcript updates", () => {
    expect(isMessageAllowed("MEET_LIVE_TRANSCRIPT_STATUS", "offscreen")).toBe(true);
    expect(isMessageAllowed("MEET_LIVE_TRANSCRIPT_UPDATE", "offscreen")).toBe(true);
  });

  it("prevents UI pages and the Meet content script from forging offscreen capture events", () => {
    for (const sender of ["extension-page", "meet-content-script"] as const) {
      expect(isMessageAllowed("MEET_LIVE_TRANSCRIPT_STATUS", sender)).toBe(false);
      expect(isMessageAllowed("MEET_LIVE_TRANSCRIPT_UPDATE", sender)).toBe(false);
      expect(isMessageAllowed("MEET_CAPTURE_ERROR", sender)).toBe(false);
      expect(isMessageAllowed("MEET_AUDIO_CHUNK", sender)).toBe(false);
    }
  });
});
