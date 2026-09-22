import { describe, expect, it } from "vitest";
import { isIncomingMessage, speakerLabel } from "../src/types";

describe("speakerLabel", () => {
  it("labels the local mic channel as You", () => {
    expect(speakerLabel("you")).toBe("You");
  });

  it("labels the first remote speaker as plain Them", () => {
    expect(speakerLabel("them")).toBe("Them");
  });

  it("distinguishes additional remote speakers instead of flattening them all to Them", () => {
    expect(speakerLabel("them-2")).toBe("Them 2");
    expect(speakerLabel("them-3")).toBe("Them 3");
  });
});

describe("isIncomingMessage", () => {
  const validMessages = [
    { type: "paired", pairingToken: "token" },
    { type: "helper_info", helperVersion: "1.0.0", protocolVersion: 1, platform: "linux" },
    { type: "recording_started", meetingId: "meeting" },
    { type: "recording_stopped", meetingId: "meeting" },
    { type: "transcript_partial", meetingId: "meeting", speaker: "you", text: "hello", isFinal: false },
    { type: "summary_ready", meetingId: "meeting", summary: "summary", actionItems: [{ text: "follow up", status: "open", dueAt: null }] },
    { type: "error", meetingId: null, code: "provider_error", message: "try again" },
    { type: "recovered_recording", meetingId: "meeting", startedAt: "2026-09-21T10:00:00Z" },
    { type: "provider_key_test_result", provider: "deepgram", valid: true, message: "ok" },
    { type: "audio_status", platform: "linux", driver: "PipeWire", driverInstalled: true, microphone: null, speaker: "Monitor", ready: true, guidance: "ready" },
    { type: "audio_probe_result", micFrames: 1, speakerFrames: 2, passed: true, message: "ok" },
  ] as const;

  it.each(validMessages)("accepts valid $type messages", (message) => {
    expect(isIncomingMessage(message)).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { type: "unknown" },
    { type: "paired", pairingToken: "" },
    { type: "helper_info", helperVersion: "1", protocolVersion: 1.5, platform: "linux" },
    { type: "recording_started", meetingId: "" },
    { type: "transcript_partial", meetingId: "m", speaker: "other", text: "x", isFinal: true },
    { type: "summary_ready", meetingId: "m", summary: "x", actionItems: [{ text: 3 }] },
    { type: "error", meetingId: 3, code: "x", message: "x" },
    { type: "provider_key_test_result", provider: "unknown", valid: false, message: "x" },
    { type: "audio_status", platform: "x", driver: "x", driverInstalled: true, microphone: 3, speaker: null, ready: true, guidance: "x" },
    { type: "audio_probe_result", micFrames: -1, speakerFrames: 0, passed: false, message: "x" },
  ])("rejects malformed messages", (message) => {
    expect(isIncomingMessage(message)).toBe(false);
  });
});
