import { describe, expect, it } from "vitest";
import { classifySender, isFromExtensionWorker, isMessageAllowed, resolveStartRequest, type SenderPolicyContext } from "../src/lib/senderPolicy";

const context: SenderPolicyContext = {
  extensionId: "abc",
  extensionBaseUrl: "chrome-extension://abc/",
  offscreenUrl: "chrome-extension://abc/meet/offscreen.html",
};

describe("classifySender", () => {
  it("recognises extension pages, the offscreen page, and the Meet content script", () => {
    expect(classifySender({ id: "abc", url: "chrome-extension://abc/popup/popup.html" }, context)).toBe("extension-page");
    expect(classifySender({ id: "abc", url: "chrome-extension://abc/settings/settings.html", tab: {} }, context)).toBe("extension-page");
    expect(classifySender({ id: "abc", url: context.offscreenUrl }, context)).toBe("offscreen");
    expect(classifySender({ id: "abc", url: "https://meet.google.com/abc-defg-hij", tab: {} }, context)).toBe("meet-content-script");
  });

  it("rejects other extensions, non-Meet pages, and tab-less web senders", () => {
    expect(classifySender({ id: "other", url: "chrome-extension://abc/popup/popup.html" }, context)).toBe("untrusted");
    expect(classifySender({ id: "abc", url: "https://evil.example/", tab: {} }, context)).toBe("untrusted");
    expect(classifySender({ id: "abc", url: "https://meet.google.com.evil.example/", tab: {} }, context)).toBe("untrusted");
    expect(classifySender({ id: "abc", url: "https://meet.google.com/abc-defg-hij" }, context)).toBe("untrusted");
    expect(classifySender({ id: "abc" }, context)).toBe("untrusted");
  });
});

describe("isMessageAllowed", () => {
  it("lets the Meet content script run the widget's requests only", () => {
    for (const type of ["GET_WIDGET_STATE", "SAVE_WIDGET_POSITION", "START_RECORDING", "STOP_RECORDING", "ADD_BOOKMARK", "OPEN_PAGE", "OPEN_MEETING", "CHECK_HELPER"] as const) {
      expect(isMessageAllowed(type, "meet-content-script")).toBe(true);
    }
    for (const type of ["SAVE_SETTINGS", "TEST_PROVIDER_KEY", "DELETE_MEETING", "DISCARD_RECORDING", "RESUME_RECORDING", "RETRY_DRIVE_EXPORT", "RETRY_MEETING_PROCESSING", "MEET_AUDIO_CHUNK", "GET_AUDIO_PREFLIGHT"] as const) {
      expect(isMessageAllowed(type, "meet-content-script")).toBe(false);
    }
  });

  it("accepts audio chunks only from the offscreen page, and nothing else from it", () => {
    expect(isMessageAllowed("MEET_AUDIO_CHUNK", "offscreen")).toBe(true);
    expect(isMessageAllowed("MEET_CAPTURE_ERROR", "offscreen")).toBe(true);
    expect(isMessageAllowed("SAVE_SETTINGS", "offscreen")).toBe(false);
    expect(isMessageAllowed("MEET_AUDIO_CHUNK", "extension-page")).toBe(false);
  });

  it("lets extension pages do everything else and untrusted senders nothing", () => {
    expect(isMessageAllowed("SAVE_SETTINGS", "extension-page")).toBe(true);
    expect(isMessageAllowed("START_RECORDING", "extension-page")).toBe(true);
    expect(isMessageAllowed("GET_STATE", "untrusted")).toBe(false);
  });
});

describe("resolveStartRequest", () => {
  it("makes a Meet content script capture its own tab in Meet mode, whatever it asked for", () => {
    expect(resolveStartRequest({ type: "START_RECORDING", tabId: 999, captureSource: "desktop" }, "meet-content-script", 7)).toEqual({ captureSource: "meet", tabId: 7 });
    expect(resolveStartRequest({ type: "START_RECORDING" }, "meet-content-script", 7)).toEqual({ captureSource: "meet", tabId: 7 });
  });

  it("lets an extension page choose, defaulting to desktop capture", () => {
    expect(resolveStartRequest({ type: "START_RECORDING", tabId: 3, captureSource: "meet" }, "extension-page", 9)).toEqual({ captureSource: "meet", tabId: 3 });
    expect(resolveStartRequest({ type: "START_RECORDING" }, "extension-page", undefined)).toEqual({ captureSource: "desktop", tabId: undefined });
  });
});

describe("isFromExtensionWorker", () => {
  const ctx = { extensionId: "abc", extensionBaseUrl: "chrome-extension://abc/" };
  it("accepts only the extension's own tab-less contexts", () => {
    expect(isFromExtensionWorker({ id: "abc", url: "chrome-extension://abc/background.js" }, ctx)).toBe(true);
    expect(isFromExtensionWorker({ id: "abc", url: "https://meet.google.com/abc-defg-hij", tab: {} }, ctx)).toBe(false);
    expect(isFromExtensionWorker({ id: "abc", url: "chrome-extension://abc/popup/popup.html", tab: {} }, ctx)).toBe(false);
    expect(isFromExtensionWorker({ id: "other", url: "chrome-extension://abc/background.js" }, ctx)).toBe(false);
    expect(isFromExtensionWorker({}, ctx)).toBe(false);
  });
});
