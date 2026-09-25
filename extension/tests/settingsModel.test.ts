import { describe, expect, it } from "vitest";
import { applyModeChoice, hasHostedSession, isHostedActive, signOutOfHosted, validateWebappInputs } from "../src/settings/settingsModel";
import { DEFAULT_SETTINGS, type NotetakerSettings } from "../src/types";

const signedIn: NotetakerSettings = {
  ...DEFAULT_SETTINGS,
  processingMode: { kind: "managed", accountId: "acct", workspaceId: "ws", plan: "pro" },
  managedService: { baseUrl: "https://notes.example.com", accessToken: "tok", accountId: "acct", workspaceId: "ws", plan: "pro" },
};

describe("hosted mode state", () => {
  it("treats a saved hosted mode as active and a session alone as signed in", () => {
    expect(isHostedActive(signedIn)).toBe(true);
    expect(isHostedActive(DEFAULT_SETTINGS)).toBe(false);
    expect(hasHostedSession(signedIn)).toBe(true);
    expect(hasHostedSession(DEFAULT_SETTINGS)).toBe(false);
  });

  it("switching to your own keys keeps the session, so switching back is one click", () => {
    const own = applyModeChoice(signedIn, false);
    expect(own.processingMode).toEqual({ kind: "local_byok" });
    expect(own.managedService).toEqual(signedIn.managedService);
    expect(applyModeChoice(own, true).processingMode).toEqual(signedIn.processingMode);
  });

  it("choosing Hosted without a session changes nothing until the user signs in", () => {
    expect(applyModeChoice(DEFAULT_SETTINGS, true)).toBe(DEFAULT_SETTINGS);
  });

  it("sign-out is separate: it drops the session and falls back to your own keys", () => {
    const out = signOutOfHosted(signedIn);
    expect(out.managedService).toBeNull();
    expect(out.processingMode).toEqual({ kind: "local_byok" });
  });
});

describe("validateWebappInputs", () => {
  it("accepts a complete pair, and clears the connection when both are blank", () => {
    expect(validateWebappInputs(" https://app.example.com ", " tok ")).toEqual({ ok: true, webapp: { url: "https://app.example.com", token: "tok" } });
    expect(validateWebappInputs("", "  ")).toEqual({ ok: true, webapp: null });
  });

  it("flags a half-filled pair on the missing field instead of silently discarding it", () => {
    expect(validateWebappInputs("https://app.example.com", "").tokenError).toMatch(/access token/i);
    expect(validateWebappInputs("", "tok").urlError).toMatch(/URL/);
  });

  it("rejects non-HTTPS URLs except on localhost", () => {
    expect(validateWebappInputs("http://app.example.com", "t").urlError).toMatch(/HTTPS/);
    expect(validateWebappInputs("http://localhost:3000", "t").ok).toBe(true);
  });
});
