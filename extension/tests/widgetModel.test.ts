import { describe, expect, it } from "vitest";
import type { WidgetState } from "../src/lib/internalMessages";
import { DONE_CARD_WINDOW_MS, canStart, deriveView, formatElapsed, type WidgetUi } from "../src/content/widgetModel";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const ui = (overrides: Partial<WidgetUi> = {}): WidgetUi => ({ starting: false, error: null, dismissedMeetingId: null, contextLost: false, ...overrides });
const state = (overrides: Partial<WidgetState> = {}): WidgetState => ({
  helperStatus: "connected",
  processingKind: "local_byok",
  onboardingComplete: true,
  consentAcknowledged: true,
  widgetEnabled: true,
  shortcuts: { toggle: "Alt+Shift+R", bookmark: "Alt+Shift+B" },
  callTitle: null,
  position: null,
  defaultMeetingMode: "general",
  disclosureNoticeEnabled: false,
  active: null,
  latest: null,
  ...overrides,
});
const latest = (overrides: Partial<NonNullable<WidgetState["latest"]>> = {}): NonNullable<WidgetState["latest"]> => ({
  id: "m1",
  title: "Sync",
  startedAt: "2026-09-24T11:00:00.000Z",
  endedAt: "2026-09-24T11:45:00.000Z",
  status: "complete",
  ...overrides,
});

describe("deriveView", () => {
  it("is disconnected without state or after the extension context is lost", () => {
    expect(deriveView(null, ui(), NOW)).toBe("disconnected");
    expect(deriveView(state(), ui({ contextLost: true }), NOW)).toBe("disconnected");
  });

  it("recording wins over everything else", () => {
    const active = { id: "m", title: "t", startedAt: "2026-09-24T11:59:00.000Z", status: "recording" as const, bookmarks: [], transcript: [] };
    expect(deriveView(state({ active, onboardingComplete: false }), ui({ starting: true, error: "x" }), NOW)).toBe("recording");
  });

  it("shows starting, then errors, then setup, in that order", () => {
    expect(deriveView(state(), ui({ starting: true }), NOW)).toBe("starting");
    expect(deriveView(state(), ui({ error: "boom" }), NOW)).toBe("error");
    expect(deriveView(state({ onboardingComplete: false }), ui(), NOW)).toBe("setup");
    expect(deriveView(state({ consentAcknowledged: false }), ui(), NOW)).toBe("setup");
  });

  it("shows processing, then a done card for a recent complete meeting", () => {
    expect(deriveView(state({ latest: latest({ status: "processing", endedAt: null }) }), ui(), NOW)).toBe("processing");
    expect(deriveView(state({ latest: latest() }), ui(), NOW)).toBe("done");
  });

  it("surfaces a recent failed meeting as an error", () => {
    expect(deriveView(state({ latest: latest({ status: "error", errorMessage: "no audio" }) }), ui(), NOW)).toBe("error");
  });

  it("stops showing an old meeting and respects dismissal", () => {
    const old = latest({ endedAt: new Date(NOW - DONE_CARD_WINDOW_MS - 1).toISOString() });
    expect(deriveView(state({ latest: old }), ui(), NOW)).toBe("ready");
    expect(deriveView(state({ latest: latest() }), ui({ dismissedMeetingId: "m1" }), NOW)).toBe("ready");
  });

  it("is ready otherwise", () => {
    expect(deriveView(state(), ui(), NOW)).toBe("ready");
  });
});

describe("widget helpers", () => {
  it("allows Meet capture without a connected desktop helper", () => {
    expect(canStart(state())).toBe(true);
    expect(canStart(state({ helperStatus: "helper_not_found" }))).toBe(true);
    expect(canStart(null)).toBe(false);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed("2026-09-24T11:59:00.000Z", NOW)).toBe("01:00");
    expect(formatElapsed("2026-09-24T10:58:59.000Z", NOW)).toBe("1:01:01");
    expect(formatElapsed("garbage", NOW)).toBe("00:00");
    expect(formatElapsed("2026-09-24T12:05:00.000Z", NOW)).toBe("00:00");
  });
});
