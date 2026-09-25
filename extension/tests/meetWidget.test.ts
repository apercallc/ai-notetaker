import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import widgetCss from "../src/content/widget.css?raw";
import { MeetWidget, type WidgetDeps } from "../src/content/widget";
import { CAPTURE_PERMISSION_HINT, MIC_PERMISSION_HINT } from "../src/meet/hints";
import type { UiToBackgroundMessage, WidgetMeeting, WidgetState } from "../src/lib/internalMessages";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function baseState(overrides: Partial<WidgetState> = {}): WidgetState {
  return {
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
  };
}

function activeMeeting(overrides: Partial<WidgetMeeting> = {}): WidgetMeeting {
  return {
    id: "m1",
    title: "Roadmap",
    startedAt: "2026-09-24T11:58:00.000Z",
    status: "recording",
    bookmarks: [],
    transcript: [],
    ...overrides,
  };
}

interface Harness {
  widget: MeetWidget;
  sent: UiToBackgroundMessage[];
  setState: (state: WidgetState) => void;
  respond: (type: UiToBackgroundMessage["type"], handler: (message: UiToBackgroundMessage) => unknown) => void;
  savePosition: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  shadow: ShadowRoot;
  $: <T extends HTMLElement = HTMLElement>(selector: string) => T | null;
  click: (selector: string) => Promise<void>;
  flush: () => Promise<void>;
  failSend: (error: Error | null) => void;
  setNow: (value: number) => void;
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function createHarness(initial: WidgetState = baseState(), position: { x: number; y: number } | null = null): Promise<Harness> {
  let state = position ? { ...initial, position } : initial;
  const sent: UiToBackgroundMessage[] = [];
  const handlers = new Map<string, (message: UiToBackgroundMessage) => unknown>();
  let failure: Error | null = null;
  let now = NOW;
  const savePosition = vi.fn();
  const reload = vi.fn();
  const deps: WidgetDeps = {
    send: (async (message: UiToBackgroundMessage) => {
      sent.push(message);
      if (message.type === "SAVE_WIDGET_POSITION") savePosition(message.position);
      if (failure) throw failure;
      const custom = handlers.get(message.type);
      if (custom) return custom(message);
      if (message.type === "GET_WIDGET_STATE") return state;
      return {};
    }) as WidgetDeps["send"],
    titleHint: () => "Google Meet abc-defg-hij",
    reload,
    now: () => now,
    shadowMode: "open",
    styles: "",
  };
  const widget = new MeetWidget(deps);
  await widget.mount();
  const shadow = widget.element.shadowRoot!;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null => shadow.querySelector<T>(selector);
  return {
    widget,
    sent,
    setState: (next) => {
      state = next;
    },
    respond: (type, handler) => handlers.set(type, handler),
    savePosition,
    reload,
    shadow,
    $,
    click: async (selector) => {
      $(selector)!.click();
      await flush();
    },
    flush,
    failSend: (error) => {
      failure = error;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

let harness: Harness | null = null;

beforeEach(() => {
  document.documentElement.querySelector("#ai-notetaker-widget-host")?.remove();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  harness?.widget.destroy();
  harness = null;
});

describe("MeetWidget: idle", () => {
  it("mounts a collapsed pill on the page and hides the panel until opened", async () => {
    harness = await createHarness();
    const { $, widget } = harness;

    expect(document.documentElement.contains(widget.element)).toBe(true);
    expect($(".nt")?.dataset.view).toBe("ready");
    expect($(".nt")?.dataset.expanded).toBe("false");
    expect($("#toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect($(".pill-main")?.textContent).toContain("Notetaker");
  });

  it("opens and closes the panel from the pill and closes it with Escape", async () => {
    harness = await createHarness();
    const { $, click } = harness;

    await click("#toggle");
    expect($(".nt")?.dataset.expanded).toBe("true");
    expect($("#toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect($("#start")).not.toBeNull();

    $("#mode")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".nt")?.dataset.expanded).toBe("false");
  });

  it("keeps the panel on the screen side that has room", async () => {
    harness = await createHarness(baseState(), { x: 1000, y: 700 });
    expect(harness.$(".nt")?.dataset.side).toBe("above");
    expect(harness.$(".nt")?.dataset.align).toBe("right");
  });

  it("keeps Meet Start available when the desktop helper is not running", async () => {
    harness = await createHarness(baseState({ helperStatus: "helper_not_found" }));
    await harness.click("#toggle");

    expect(harness.$<HTMLButtonElement>("#start")?.disabled).toBe(false);
    expect(harness.$("#helper-note")).toBeNull();
  });

  it("re-enables Start as soon as the helper connects", async () => {
    harness = await createHarness(baseState({ helperStatus: "connecting" }));
    await harness.click("#toggle");
    harness.setState(baseState());
    harness.widget.handleMessage({ type: "HELPER_STATUS", status: "connected" });
    await harness.flush();

    expect(harness.$<HTMLButtonElement>("#start")?.disabled).toBe(false);
    expect(harness.$("#helper-note")).toBeNull();
  });

  it("sends people who have not finished setup to the wizard", async () => {
    harness = await createHarness(baseState({ onboardingComplete: false }));
    await harness.click("#toggle");

    expect(harness.$(".nt")?.dataset.view).toBe("setup");
    await harness.click("#open-setup");
    expect(harness.sent).toContainEqual({ type: "OPEN_PAGE", page: "onboarding" });
  });

  it("hides itself when the user turns the widget off in settings", async () => {
    harness = await createHarness(baseState({ widgetEnabled: false }));
    expect(harness.widget.element.style.display).toBe("none");

    harness.setState(baseState());
    await harness.widget.refresh();
    expect(harness.widget.element.style.display).toBe("");
  });

  it("shows a reload prompt when the extension was updated under the page", async () => {
    harness = await createHarness();
    harness.failSend(new Error("Extension context invalidated."));
    await harness.widget.refresh();

    expect(harness.$(".nt")?.dataset.view).toBe("disconnected");
    await harness.click("#reload");
    expect(harness.reload).toHaveBeenCalled();
  });
});

describe("MeetWidget: starting a recording", () => {
  it("starts Meet capture with the chosen style and the tab's title", async () => {
    harness = await createHarness();
    const { $, click, respond, setState } = harness;
    respond("START_RECORDING", () => {
      setState(baseState({ active: activeMeeting() }));
      return { meetingId: "m1" };
    });

    await click("#toggle");
    const mode = $<HTMLSelectElement>("#mode")!;
    mode.value = "standup";
    mode.dispatchEvent(new Event("change"));
    await click("#start");

    expect(harness.sent).toContainEqual({
      type: "START_RECORDING",
      captureSource: "meet",
      meetingMode: "standup",
      titleHint: "Google Meet abc-defg-hij",
    });
    expect($(".nt")?.dataset.view).toBe("recording");
    expect($(".nt")?.dataset.expanded).toBe("false");
    expect($(".toast")?.textContent).toBe("Recording started. Let everyone know.");
  });

  it("gives a one-step Chrome instruction without offering a retry that cannot work", async () => {
    harness = await createHarness();
    const { $, click, respond, widget } = harness;
    respond("START_RECORDING", () => {
      widget.handleMessage({ type: "RECORDING_ERROR", meetingId: "m1", message: CAPTURE_PERMISSION_HINT });
      return { meetingId: "" };
    });

    await click("#toggle");
    await click("#start");

    expect($(".nt")?.dataset.view).toBe("error");
    expect($("h2")?.textContent).toBe("One Chrome step");
    expect($(".note.warning")?.textContent).toContain("Click it once; recording will start automatically.");
    expect(Array.from($(".note.warning")!.querySelectorAll("kbd")).map((key) => key.textContent)).toEqual(["Alt", "Shift", "R"]);
    expect($("#retry")).toBeNull();
    expect($("#dismiss")?.textContent).toBe("Got it");
  });

  it("does not promise a shortcut Chrome never assigned", async () => {
    harness = await createHarness(baseState({ shortcuts: { toggle: "", bookmark: "" } }));
    const { $, click, respond, widget } = harness;
    respond("START_RECORDING", () => {
      widget.handleMessage({ type: "RECORDING_ERROR", meetingId: "m1", message: CAPTURE_PERMISSION_HINT });
      return { meetingId: "" };
    });
    await click("#toggle");
    await click("#start");

    expect($(".note.warning kbd")).toBeNull();
    expect($(".note.warning")?.textContent).not.toMatch(/Or press/);
  });

  it("shows macOS-style bindings as individual keycaps", async () => {
    harness = await createHarness(baseState({ shortcuts: { toggle: "⌥⇧R", bookmark: "⌥⇧B" } }));
    await harness.click("#toggle");
    expect(Array.from(harness.$(".panel .keys")!.querySelectorAll("kbd")).map((key) => key.textContent)).toEqual(["⌥", "⇧", "R"]);
    expect(harness.$("#pill-start")?.getAttribute("title")).toBe("Start notes (⌥⇧R)");
  });

  it("offers to set a shortcut when none is assigned", async () => {
    harness = await createHarness(baseState({ shortcuts: { toggle: "", bookmark: "" } }));
    await harness.click("#toggle");
    expect(harness.$("#pill-start")?.getAttribute("title")).toBe("Start notes");
    await harness.click("#set-shortcut");
    expect(harness.sent).toContainEqual({ type: "OPEN_PAGE", page: "shortcuts" });
  });

  it("names the call from the calendar when it knows which one this is", async () => {
    harness = await createHarness(baseState({ callTitle: "Weekly <sync>" }));
    await harness.click("#toggle");
    expect(harness.$(".panel .sub strong")?.textContent).toBe("Weekly <sync>");
    expect(harness.$(".panel .sub img")).toBeNull();
  });

  it("picks up the calendar title when it arrives after the first render", async () => {
    harness = await createHarness();
    await harness.click("#toggle");
    expect(harness.$(".panel .sub strong")).toBeNull();

    harness.setState(baseState({ callTitle: "Weekly sync" }));
    harness.widget.handleMessage({ type: "MEETING_STATE_CHANGED", meetingId: "" });
    await harness.flush();

    expect(harness.$(".panel .sub strong")?.textContent).toBe("Weekly sync");
    expect(harness.$(".nt")?.dataset.expanded).toBe("true");
  });

  it("keeps helper errors that arrive while idle out of the error card", async () => {
    harness = await createHarness();
    harness.widget.handleMessage({ type: "RECORDING_ERROR", meetingId: null, message: "pairing token missing or mismatched" });
    await harness.flush();
    expect(harness.$(".nt")?.dataset.view).toBe("ready");
  });

  it("offers a direct route to the microphone grant when that is what is missing", async () => {
    harness = await createHarness();
    const { $, click, respond, widget } = harness;
    respond("START_RECORDING", () => {
      widget.handleMessage({ type: "RECORDING_ERROR", meetingId: "m1", message: MIC_PERMISSION_HINT });
      return { meetingId: "" };
    });
    await click("#toggle");
    await click("#start");

    expect($("#allow-mic")).not.toBeNull();
    await click("#allow-mic");
    expect(harness.sent).toContainEqual({ type: "OPEN_PAGE", page: "microphone" });
  });

  it("explains a start that produced no meeting and no message", async () => {
    harness = await createHarness();
    harness.respond("START_RECORDING", () => ({ meetingId: "" }));
    await harness.click("#toggle");
    await harness.click("#start");

    expect(harness.$(".nt")?.dataset.view).toBe("error");
    expect(harness.$(".note.error")?.textContent).toMatch(/could not start/i);
  });

  it("does not start twice on a double click", async () => {
    harness = await createHarness();
    let release: (() => void) | undefined;
    harness.respond("START_RECORDING", () => new Promise((resolve) => { release = () => resolve({ meetingId: "" }); }));
    await harness.click("#toggle");
    const start = harness.$<HTMLButtonElement>("#start")!;
    start.click();
    start.click();
    release?.();
    await harness.flush();

    expect(harness.sent.filter((message) => message.type === "START_RECORDING")).toHaveLength(1);
  });
});

describe("MeetWidget: recording", () => {
  async function recording(active: Partial<WidgetMeeting> = {}): Promise<Harness> {
    const h = await createHarness(baseState({ active: activeMeeting(active) }));
    return h;
  }

  it("shows an unmistakable recording state with elapsed time and quick actions", async () => {
    harness = await recording();
    const { $ } = harness;

    expect($(".nt")?.dataset.view).toBe("recording");
    expect($(".pill-main")?.textContent).toContain("Recording");
    expect($("#elapsed")?.textContent).toBe("02:00");
    expect($("#pill-bookmark")?.getAttribute("aria-label")).toBe("Flag this moment");
    expect($("#pill-stop")?.getAttribute("aria-label")).toBe("Stop notes");
  });

  it("shows the live transcript connection state without promising unavailable captions", async () => {
    harness = await recording({ liveTranscriptStatus: "connecting" });
    expect(harness.$("#transcript .empty")?.textContent).toBe("Connecting to live transcript…");
    harness.setState(baseState({ active: activeMeeting({ liveTranscriptStatus: "unavailable" }) }));
    await harness.widget.refresh();
    expect(harness.$("#transcript .empty")?.textContent).toBe("Live transcript unavailable. Your full transcript will be ready after you stop recording.");
  });

  it("renders the live transcript from state and upserts provisional lines in place", async () => {
    harness = await recording({ transcript: [{ speaker: "you", text: "Hello team", isFinal: true, utteranceId: 1 }] });
    const { $, widget } = harness;
    await harness.click("#toggle");

    expect($("#transcript")?.querySelectorAll(".line")).toHaveLength(1);
    widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "them-2", text: "Hi", isFinal: false, utteranceId: 7 });
    widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "them-2", text: "Hi, thanks for joining", isFinal: false, utteranceId: 7 });

    const lines = $("#transcript")!.querySelectorAll<HTMLElement>(".line");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.classList.contains("provisional")).toBe(true);
    expect(lines[1]?.textContent).toContain("Them 2");
    expect(lines[1]?.textContent).toContain("Hi, thanks for joining");

    widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "them-2", text: "Hi, thanks for joining.", isFinal: true, utteranceId: 7 });
    expect($("#transcript")!.querySelectorAll(".line")).toHaveLength(2);
    expect(lines[1]?.classList.contains("provisional")).toBe(false);
  });

  it("ignores transcript updates for a different meeting", async () => {
    harness = await recording();
    harness.widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "other", speaker: "you", text: "nope", isFinal: true, utteranceId: 1 });
    expect(harness.$("#transcript")?.querySelectorAll(".line")).toHaveLength(0);
  });

  it("never renders transcript text as HTML", async () => {
    harness = await recording();
    harness.widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "you", text: `<img src=x onerror="window.pwned=1">`, isFinal: true, utteranceId: 1 });

    expect(harness.$("#transcript img")).toBeNull();
    expect(harness.$("#transcript .txt")?.textContent).toBe(`<img src=x onerror="window.pwned=1">`);
  });

  it("caps the transcript DOM so a long call stays light", async () => {
    harness = await recording();
    for (let index = 0; index < 260; index += 1) {
      harness.widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "you", text: `line ${index}`, isFinal: true, utteranceId: index });
    }
    expect(harness.$("#transcript")?.querySelectorAll(".line")).toHaveLength(200);
    expect(harness.$("#transcript")?.textContent).toContain("line 259");
    expect(harness.$("#transcript")?.textContent).not.toContain("line 0");
  });

  it("flags a moment with a note, clears the field, and confirms with a toast", async () => {
    harness = await recording();
    const { $, respond, setState, flush } = harness;
    respond("ADD_BOOKMARK", (message) => {
      const note = (message as { note?: string }).note ?? "";
      setState(baseState({ active: activeMeeting({ bookmarks: [{ id: "b1", offsetMs: 125_000, note, createdAt: "x" }] }) }));
      return { ok: true };
    });
    await harness.click("#toggle");

    const input = $<HTMLInputElement>("#moment-note")!;
    input.value = "pricing decision";
    input.dispatchEvent(new Event("input"));
    $("#moment-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(harness.sent).toContainEqual({ type: "ADD_BOOKMARK", meetingId: "m1", note: "pricing decision" });
    expect($<HTMLInputElement>("#moment-note")!.value).toBe("");
    expect($("#moments")?.textContent).toContain("2:05");
    expect($("#moments")?.textContent).toContain("pricing decision");
    expect($(".toast")?.textContent).toMatch(/Moment flagged at 02:00/);
  });

  it("flags a moment straight from the pill without opening the panel", async () => {
    harness = await recording();
    await harness.click("#pill-bookmark");
    expect(harness.sent).toContainEqual({ type: "ADD_BOOKMARK", meetingId: "m1", note: "" });
  });

  it("keeps a half-typed note when state refreshes", async () => {
    harness = await recording();
    await harness.click("#toggle");
    const input = harness.$<HTMLInputElement>("#moment-note")!;
    input.value = "draft";
    input.dispatchEvent(new Event("input"));

    await harness.widget.refresh();
    harness.widget.handleMessage({ type: "MEETING_STATE_CHANGED", meetingId: "m1" });
    await harness.flush();

    expect(harness.$<HTMLInputElement>("#moment-note")!.value).toBe("draft");
  });

  it("summarises only the newest flagged moments", async () => {
    const bookmarks = Array.from({ length: 8 }, (_, index) => ({ id: `b${index}`, offsetMs: index * 1000, note: `n${index}`, createdAt: "x" }));
    harness = await recording({ bookmarks });
    const items = harness.$("#moments")!.querySelectorAll("li");

    expect(items).toHaveLength(6);
    expect(items[0]?.textContent).toContain("n7");
    expect(items[5]?.textContent).toContain("+3 earlier");
  });

  it("stops from the pill, then shows the writing-notes state", async () => {
    harness = await recording();
    const { respond, setState } = harness;
    respond("STOP_RECORDING", () => {
      setState(baseState({ latest: { id: "m1", title: "Roadmap", startedAt: "2026-09-24T11:58:00.000Z", endedAt: null, status: "processing" } }));
      return {};
    });

    await harness.click("#pill-stop");
    expect(harness.sent.some((message) => message.type === "STOP_RECORDING")).toBe(false);
    expect(harness.$("#pill-stop")?.textContent).toBe("Stop notes?");
    await harness.click("#pill-stop");

    expect(harness.sent).toContainEqual({ type: "STOP_RECORDING", meetingId: "m1" });
    expect(harness.$(".nt")?.dataset.view).toBe("processing");
    expect(harness.$(".nt")?.dataset.expanded).toBe("true");
    expect(harness.$(".panel h2")?.textContent).toBe("Writing your notes…");
  });
});

describe("MeetWidget: after the call", () => {
  it("offers the finished notes and lets the user dismiss the card", async () => {
    harness = await createHarness(
      baseState({ latest: { id: "m1", title: "Roadmap sync", startedAt: "2026-09-24T11:00:00.000Z", endedAt: "2026-09-24T11:45:00.000Z", status: "complete" } }),
    );
    expect(harness.$(".nt")?.dataset.view).toBe("done");
    expect(harness.$(".pill-main")?.textContent).toContain("Notes ready");
    await harness.click("#toggle");
    expect(harness.$(".panel")?.textContent).toContain("Roadmap sync");

    await harness.click("#open-notes");
    expect(harness.sent).toContainEqual({ type: "OPEN_MEETING", meetingId: "m1" });

    await harness.click("#dismiss");
    expect(harness.$(".nt")?.dataset.view).toBe("ready");
    expect(harness.$(".nt")?.dataset.expanded).toBe("false");
  });

  it("shows why a meeting failed", async () => {
    harness = await createHarness(
      baseState({ latest: { id: "m2", title: "Sync", startedAt: "2026-09-24T11:00:00.000Z", endedAt: "2026-09-24T11:45:00.000Z", status: "error", errorMessage: "No audio was captured." } }),
    );
    expect(harness.$(".nt")?.dataset.view).toBe("error");
    expect(harness.$(".note.error")?.textContent).toBe("No audio was captured.");
  });
});

describe("MeetWidget: isolation and dragging", () => {
  it("keeps typing inside the widget from reaching Meet's own keyboard shortcuts", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    const documentListener = vi.fn();
    document.addEventListener("keydown", documentListener);
    await harness.click("#toggle");

    harness.$("#moment-note")!.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true, composed: true }));

    document.removeEventListener("keydown", documentListener);
    expect(documentListener).not.toHaveBeenCalled();
  });

  it("does not expose its shadow root to the page in production mode", async () => {
    const closed = new MeetWidget({
      send: (async () => baseState()) as WidgetDeps["send"],
      titleHint: () => undefined,
      reload: () => {},
    });
    expect(closed.element.shadowRoot).toBeNull();
    closed.destroy();
  });

  it("remembers where the user drops it and keeps it on screen", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;

    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 0, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointermove", { clientX: 5000, clientY: 90, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerup", { clientX: 5000, clientY: 90, bubbles: true, composed: true }));

    expect(harness.savePosition).toHaveBeenCalledTimes(1);
    const saved = harness.savePosition.mock.calls[0]![0] as { x: number; y: number };
    expect(saved.x).toBeLessThanOrEqual(1280 - 8);
    expect(saved.x).toBeGreaterThan(1000);
    expect(saved.y).toBe(72);
  });

  it("follows a fast flick that leaves the pill before its first move event", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;

    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 0, bubbles: true, composed: true }));
    // The first move arrives from far outside the pill, so it lands on the window, not the pill.
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 330, clientY: 290 }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 330, clientY: 290 }));

    expect(harness.savePosition).toHaveBeenCalledTimes(1);
    expect(harness.savePosition).toHaveBeenCalledWith({ x: 316, y: 272 });
  });

  it("stops listening once the press ends, so later moves do not drag it", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;
    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 0, bubbles: true, composed: true }));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 30, clientY: 90 }));

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 800, clientY: 600 }));
    expect(harness.widget.element.style.transform).toBe("translate(16px, 72px)");
    expect(harness.savePosition).not.toHaveBeenCalled();
  });

  it("treats a tiny wobble as a click, not a drag", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;
    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 0, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointermove", { clientX: 31, clientY: 91, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerup", { clientX: 31, clientY: 91, bubbles: true, composed: true }));

    expect(harness.savePosition).not.toHaveBeenCalled();
  });

  it("removes itself cleanly", async () => {
    harness = await createHarness();
    const host = harness.widget.element;
    harness.widget.destroy();
    expect(document.documentElement.contains(host)).toBe(false);
  });
});


describe("MeetWidget: edge cases and resilience", () => {
  it("starts at the default spot when nothing was saved, and where the user left it otherwise", async () => {
    harness = await createHarness();
    expect(harness.widget.element.style.transform).toBe("translate(16px, 72px)");
    harness.widget.destroy();

    harness = await createHarness(baseState(), { x: 300, y: 200 });
    expect(harness.widget.element.style.transform).toBe("translate(300px, 200px)");
  });

  it("pulls itself back on screen when the window shrinks", async () => {
    harness = await createHarness(baseState(), { x: 1100, y: 700 });
    Object.defineProperty(window, "innerWidth", { value: 600, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    window.dispatchEvent(new Event("resize"));

    const match = /translate\((\d+)px, (\d+)px\)/.exec(harness.widget.element.style.transform);
    expect(Number(match?.[1])).toBeLessThan(600);
    expect(Number(match?.[2])).toBeLessThan(400);
  });

  it("falls back to the disconnected view when the background cannot be reached for another reason", async () => {
    harness = await createHarness();
    harness.failSend(new Error("boom"));
    await harness.widget.refresh();
    expect(harness.$(".nt")?.dataset.view).toBe("disconnected");
  });

  it("collapses concurrent refreshes into one trailing refresh", async () => {
    harness = await createHarness();
    const before = harness.sent.filter((message) => message.type === "GET_WIDGET_STATE").length;
    void harness.widget.refresh();
    void harness.widget.refresh();
    void harness.widget.refresh();
    await harness.flush();
    expect(harness.sent.filter((message) => message.type === "GET_WIDGET_STATE").length - before).toBe(2);
  });

  it("ignores background messages it does not care about", async () => {
    harness = await createHarness();
    const before = harness.sent.length;
    harness.widget.handleMessage({ type: "DRIVE_EXPORT", meetingId: "m", status: "exported" });
    harness.widget.handleMessage({ type: "RECOVERABLE_RECORDING", meetingId: "m", startedAt: "x" });
    await harness.flush();
    expect(harness.sent.length).toBe(before);
  });

  it("does not render after it was destroyed while a refresh was in flight", async () => {
    harness = await createHarness();
    const pending = harness.widget.refresh();
    harness.widget.destroy();
    await pending;
    harness.widget.handleMessage({ type: "MEETING_STATE_CHANGED", meetingId: "m" });
    await harness.flush();
    expect(document.documentElement.contains(harness.widget.element)).toBe(false);
  });

  it("toggles from the chevron and keeps focus in the widget after a re-render", async () => {
    harness = await createHarness();
    await harness.click("#chevron");
    expect(harness.$(".nt")?.dataset.expanded).toBe("true");
    expect(harness.$("#chevron")?.getAttribute("aria-label")).toBe("Collapse notes panel");

    (harness.$("#toggle") as HTMLElement).focus();
    harness.setState(baseState({ helperStatus: "helper_not_found" }));
    await harness.widget.refresh();
    expect(harness.$("#helper-note")).toBeNull();
    expect(harness.shadow.activeElement?.id).toBe("toggle");
  });

  it("does not redirect Meet users to desktop-helper setup", async () => {
    harness = await createHarness(baseState({ helperStatus: "helper_not_found" }));
    await harness.click("#toggle");
    expect(harness.$("#helper-setup")).toBeNull();
    expect(harness.$("#helper-note")).toBeNull();
  });

  it("stops from the panel button too, after the same two-press confirm", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    await harness.click("#toggle");
    await harness.click("#stop");
    expect(harness.sent.some((message) => message.type === "STOP_RECORDING")).toBe(false);
    expect(harness.$("#stop")?.textContent).toBe("Stop notes?");
    await harness.click("#stop");
    expect(harness.sent).toContainEqual({ type: "STOP_RECORDING", meetingId: "m1" });
  });

  it("tells the user when stopping cannot be confirmed, without losing the recording", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    harness.respond("STOP_RECORDING", () => {
      throw new Error("port closed");
    });
    await harness.click("#toggle");
    await harness.click("#stop");
    await harness.click("#stop");
    expect(harness.$(".nt")?.dataset.view).toBe("recording");
  });

  it("explains a start that threw", async () => {
    harness = await createHarness();
    harness.respond("START_RECORDING", () => {
      throw new Error("network");
    });
    await harness.click("#toggle");
    await harness.click("#start");
    expect(harness.$(".nt")?.dataset.view).toBe("error");
    expect(harness.$(".note.error")?.textContent).toMatch(/could not start/i);
  });

  it("switches to the reload prompt when the extension context dies mid-start", async () => {
    harness = await createHarness();
    const h = harness;
    h.respond("START_RECORDING", () => {
      // Once the context is gone every later call fails too, including the refresh.
      h.failSend(new Error("Extension context invalidated."));
      throw new Error("Extension context invalidated.");
    });
    await harness.click("#toggle");
    await harness.click("#start");
    expect(harness.$(".nt")?.dataset.view).toBe("disconnected");
  });

  it("says so when a moment could not be flagged", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    harness.respond("ADD_BOOKMARK", () => ({ ok: false }));
    await harness.click("#pill-bookmark");
    expect(harness.$(".toast")?.textContent).toBe("This moment couldn't be flagged");

    harness.respond("ADD_BOOKMARK", () => {
      throw new Error("gone");
    });
    await harness.click("#pill-bookmark");
    expect(harness.$(".toast")?.textContent).toBe("This moment couldn't be flagged");
  });

  it("announces retried transcription chunks", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    harness.widget.handleMessage({ type: "PROCESSING_WARNING", meetingId: "m1", message: "retry" });
    expect(harness.$(".toast")?.textContent).toMatch(/retried automatically/);
  });

  it("offers Jump to latest when the reader scrolled up and new lines arrive", async () => {
    harness = await createHarness(
      baseState({ active: activeMeeting({ transcript: [{ speaker: "you", text: "first", isFinal: true, utteranceId: 1 }] }) }),
    );
    await harness.click("#toggle");
    const transcript = harness.$("#transcript")!;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 1000 };
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(transcript, key, { value, configurable: true, writable: true });
    }

    transcript.dispatchEvent(new Event("scroll"));
    harness.widget.handleMessage({ type: "TRANSCRIPT_UPDATE", meetingId: "m1", speaker: "them", text: "new", isFinal: true, utteranceId: 2 });
    expect(harness.$("#jump")?.hasAttribute("hidden")).toBe(false);

    await harness.click("#jump");
    expect(transcript.scrollTop).toBe(1000);

    metrics.scrollTop = 900;
    transcript.scrollTop = 900;
    transcript.dispatchEvent(new Event("scroll"));
    expect(harness.$("#jump")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("MeetWidget: timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    harness?.widget.destroy();
    harness = null;
    vi.useRealTimers();
  });

  it("ticks the elapsed time once a second while recording", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    expect(harness.$("#elapsed")?.textContent).toBe("02:00");

    harness.setNow(NOW + 5_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.$("#elapsed")?.textContent).toBe("02:05");
  });

  it("hides the confirmation toast after a moment", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    harness.widget.handleMessage({ type: "PROCESSING_WARNING", meetingId: "m1", message: "retry" });
    expect(harness.$(".toast")?.classList.contains("show")).toBe(true);
    await vi.advanceTimersByTimeAsync(2600);
    expect(harness.$(".toast")?.classList.contains("show")).toBe(false);
  });
});

describe("MeetWidget: pointer handling", () => {
  it("ignores secondary-button presses and stray pointer events", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;
    pill.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 500, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerup", { clientX: 500, clientY: 500, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 2, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 500, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerup", { clientX: 500, clientY: 500, bubbles: true, composed: true }));
    expect(harness.savePosition).not.toHaveBeenCalled();
  });

  it("does not treat the click that ends a drag as a press on the control under the pointer", async () => {
    harness = await createHarness();
    const pill = harness.$(".pill")!;
    pill.dispatchEvent(new MouseEvent("pointerdown", { clientX: 30, clientY: 90, button: 0, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300, bubbles: true, composed: true }));
    pill.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 300, bubbles: true, composed: true }));

    harness.$<HTMLButtonElement>("#toggle")!.click();
    expect(harness.$(".nt")?.dataset.expanded).toBe("false");

    harness.$<HTMLButtonElement>("#toggle")!.click();
    expect(harness.$(".nt")?.dataset.expanded).toBe("true");
  });
});

describe("MeetWidget: one-click start, consent, and announcements", () => {
  it("offers a primary Start right on the idle pill when the helper is connected", async () => {
    harness = await createHarness();
    harness.respond("START_RECORDING", () => ({ meetingId: "" }));

    expect(harness.$("#pill-start")?.textContent).toBe("Start notes");
    await harness.click("#pill-start");
    expect(harness.sent).toContainEqual(expect.objectContaining({ type: "START_RECORDING", captureSource: "meet" }));
  });

  it("keeps the pill Start available for browser Meet capture without the helper", async () => {
    harness = await createHarness(baseState({ helperStatus: "helper_not_found" }));
    expect(harness.$("#pill-start")).not.toBeNull();
  });

  it("puts the consent reminder above the Start button in plain, prominent words", async () => {
    harness = await createHarness();
    await harness.click("#toggle");
    const consent = harness.$(".consent")!;
    const start = harness.$("#start")!;

    expect(consent.textContent).toMatch(/Nobody else is notified/);
    expect(consent.textContent).toMatch(/recording/);
    expect(consent.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("describes where audio goes honestly while connecting", async () => {
    harness = await createHarness();
    let release: (() => void) | undefined;
    harness.respond("START_RECORDING", () => new Promise((resolve) => { release = () => resolve({ meetingId: "" }); }));
    await harness.click("#toggle");
    harness.$<HTMLButtonElement>("#start")!.click();
    await harness.flush();

    expect(harness.$(".panel")?.textContent).toMatch(/sent to your transcription and summary providers, using your own API keys/);
    release?.();
    await harness.flush();
  });

  it("keeps a single live region outside the re-rendered view and leaves the transcript silent", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    const region = harness.shadow.querySelector(".sr-status")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(harness.$("#transcript")?.getAttribute("aria-live")).toBe("off");

    harness.setState(baseState());
    await harness.widget.refresh();
    expect(harness.shadow.querySelector(".sr-status")).toBe(region);
  });

  it("announces the result of stopping and the failure of a start", async () => {
    vi.useFakeTimers();
    try {
      harness = await createHarness(baseState({ active: activeMeeting() }));
      harness.setState(baseState({ latest: { id: "m1", title: "Roadmap", startedAt: "2026-09-24T11:58:00.000Z", endedAt: null, status: "processing" } }));
      await harness.widget.refresh();
      await vi.advanceTimersByTimeAsync(50);
      expect(harness.shadow.querySelector(".sr-status")?.textContent).toBe("Writing your notes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves red for the recording dot and uses amber for problems", () => {
    const css = widgetCss;
    expect(css).toMatch(/\.nt\[data-view="error"\] \.dot,\s*\.nt\[data-view="disconnected"\] \.dot \{\s*background: var\(--warn\);/);
    expect(css).toMatch(/\.nt\[data-view="recording"\] \.dot \{\s*background: var\(--recording\);/);
  });

  it("only lets the pill stop button end a recording on the second press, and lets it lapse", async () => {
    vi.useFakeTimers();
    try {
      harness = await createHarness(baseState({ active: activeMeeting() }));
      harness.$<HTMLButtonElement>("#pill-stop")!.click();
      expect(harness.$("#pill-stop")?.classList.contains("armed")).toBe(true);
      expect(harness.$("#pill-stop")?.getAttribute("aria-label")).toMatch(/Confirm/);

      await vi.advanceTimersByTimeAsync(3100);
      expect(harness.$("#pill-stop")?.classList.contains("armed")).toBe(false);
      expect(harness.sent.some((message) => message.type === "STOP_RECORDING")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the user hide a slow summary and start again, and says why it is slow", async () => {
    harness = await createHarness(baseState({ latest: { id: "m1", title: "Roadmap", startedAt: "2026-09-24T11:58:00.000Z", endedAt: null, status: "processing" } }));
    await harness.click("#toggle");
    harness.widget.handleMessage({ type: "PROCESSING_WARNING", meetingId: "m1", message: "transcription failed, queued for retry: 401" });
    expect(harness.$(".panel .note.warn")?.textContent).toMatch(/Still trying: transcription failed, queued for retry: 401/);
    expect(harness.$(".panel .note.warn")?.textContent).toMatch(/check your API keys/);

    await harness.click("#dismiss");
    expect(harness.$(".nt")?.dataset.view).toBe("ready");
    expect(harness.$("#pill-start")).not.toBeNull();
  });

  it("shows a post-call failure as details to open, not a retry that cannot work", async () => {
    harness = await createHarness(
      baseState({ latest: { id: "m2", title: "Sync", startedAt: "2026-09-24T11:00:00.000Z", endedAt: "2026-09-24T11:45:00.000Z", status: "error", errorMessage: "No audio was captured." } }),
    );
    await harness.click("#toggle");
    expect(harness.$("#retry")).toBeNull();
    await harness.click("#open-notes");
    expect(harness.sent).toContainEqual({ type: "OPEN_MEETING", meetingId: "m2" });
  });

  it("does not let a changing timer rename the toggle button for screen readers", async () => {
    harness = await createHarness(baseState({ active: activeMeeting() }));
    expect(harness.$("#toggle")?.getAttribute("aria-label")).toBe("Recording");
  });

  it("can be moved with the arrow keys, remembering the new spot", async () => {
    harness = await createHarness();
    const toggle = harness.$<HTMLButtonElement>("#toggle")!;
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(harness.savePosition).toHaveBeenCalledTimes(2);
    expect(harness.savePosition).toHaveBeenLastCalledWith({ x: 32, y: 136 });
  });
});
