import { describe, expect, it } from "vitest";
import { hasMeetingWidget } from "../src/meet/meetingSites";
import { classifySender, isMessageAllowed, resolveStartRequest } from "../src/lib/senderPolicy";

const context = { extensionId: "own", extensionBaseUrl: "chrome-extension://own/", offscreenUrl: "chrome-extension://own/meet/offscreen.html" };

describe("meeting web app controls", () => {
  it.each([
    "https://meet.google.com/abc-defg-hij",
    "https://teams.microsoft.com/v2/",
    "https://teams.cloud.microsoft/v2/",
    "https://teams.live.com/v2/",
    "https://zoom.us/wc/123/join",
    "https://us02web.zoom.us/wc/123/start",
    "https://app.zoom.us/wc/123/join",
    "https://discord.com/channels/@me/123",
    "https://app.slack.com/client/T123/C123",
    "https://app.slack.com/huddle/T123/C123",
  ])("allows controls on %s without allowing storage or provider commands", (url) => {
    expect(hasMeetingWidget(url)).toBe(true);
    const kind = classifySender({ id: "own", url, tab: { id: 7 } }, context);
    expect(isMessageAllowed("START_RECORDING", kind)).toBe(true);
    expect(isMessageAllowed("GET_STATE", kind)).toBe(false);
    expect(isMessageAllowed("SAVE_SETTINGS", kind)).toBe(false);
    expect(isMessageAllowed("MEET_AUDIO_CHUNK", kind)).toBe(false);
    expect(resolveStartRequest({ type: "START_RECORDING", tabId: 99, captureSource: "desktop" }, kind, 7)).toEqual({ captureSource: "meet", tabId: 7 });
  });

  it.each([
    undefined, "bad url", "http://teams.microsoft.com/v2/", "https://teams.microsoft.com:444/v2/",
    "https://teams.microsoft.com.evil.test/v2/", "https://evilzoom.us/wc/123/join",
    "https://meet.google.com/", "https://zoom.us/pricing", "https://teams.microsoft.com/logout",
    "https://discord.com/login", "https://app.slack.com/", "https://slack.com/features/huddles",
  ])("does not show controls or trust senders on %s", (url) => {
    expect(hasMeetingWidget(url)).toBe(false);
    expect(classifySender({ id: "own", url, tab: { id: 7 } }, context)).toBe("untrusted");
  });
});
