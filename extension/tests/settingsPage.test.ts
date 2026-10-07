import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { saveSettings } from "../src/lib/storage";
import { DEFAULT_SETTINGS, type NotetakerSettings } from "../src/types";

const hosted: NotetakerSettings = {
  ...DEFAULT_SETTINGS,
  processingMode: { kind: "managed", accountId: "acct", workspaceId: "ws", plan: "pro" },
  managedService: { baseUrl: "https://notes.example.com", accessToken: "tok", accountId: "acct", workspaceId: "ws", plan: "pro" },
};

async function openSettings(settings: NotetakerSettings): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  chromeMock.reset();
  chromeMock.runtime.sendMessage.mockResolvedValue({});
  await saveSettings(settings);
  await import("../src/settings/settings");
  await vi.waitFor(() => expect(document.getElementById("save-settings")).not.toBeNull());
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const savedSettings = (): NotetakerSettings | undefined =>
  (chromeMock.runtime.sendMessage.mock.calls.map((call) => call[0]) as Array<{ type: string; settings?: NotetakerSettings }>)
    .filter((message) => message.type === "SAVE_SETTINGS")
    .at(-1)?.settings;

describe("settings page: API keys", () => {
  it("moves existing users to API processing and removes sign-in controls", async () => {
    await openSettings(hosted);
    expect(document.getElementById("key-deepgram")).not.toBeNull();
    expect(document.getElementById("meeting-minutes")).not.toBeNull();
    expect(document.getElementById("managed-sign-in")).toBeNull();
    expect(document.getElementById("managed-google-sign-in")).toBeNull();
    await vi.waitFor(() => expect(savedSettings()?.processingMode).toEqual({ kind: "local_byok" }));
    expect(savedSettings()?.managedService?.accessToken).toBe("tok");
  });

  it("explains key setup and links to the selected providers", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect(document.body.textContent).toContain("No AI Notetaker account is needed");
    expect(document.querySelector('a[href="https://console.deepgram.com/"]')).not.toBeNull();
    expect(document.querySelector('a[href="https://console.anthropic.com/settings/keys"]')).not.toBeNull();
    expect(document.getElementById("managed-email")).toBeNull();
    expect(document.getElementById("mode-managed")).toBeNull();
  });

  it("keeps web app history optional alongside API keys", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect(document.getElementById("webapp-url")).not.toBeNull();
    expect(document.getElementById("meeting-minutes")).not.toBeNull();
  });
});

describe("settings page: structure", () => {
  it("keeps all optional connections collapsed and removes browser OAuth-client setup", async () => {
    await openSettings(DEFAULT_SETTINGS);
    const legends = [...document.querySelectorAll("legend")].map((legend) => legend.textContent);
    expect(legends).toEqual(["Provider API keys", "Notes preferences", "Shortcuts and Meet widget", "Move to the desktop app"]);

    const integrations = $<HTMLDetailsElement>("integrations");
    expect(integrations.open).toBe(false);
    expect(integrations.querySelector("summary")?.textContent).toBe("Connections & history (optional)");
    expect(integrations.querySelector("#webapp-url")).not.toBeNull();
    expect(integrations.querySelector("#google-services-heading")?.textContent).toBe("Google Calendar & Drive");
    expect(document.getElementById("calendar-client-id")).toBeNull();
    expect(document.getElementById("drive-client-id")).toBeNull();
    expect(document.querySelector("input[id*='client'], input[id*='secret']")).toBeNull();
  });
});

describe("settings page: unsaved input", () => {
  it("keeps typed keys and vocabulary across provider tier switches", async () => {
    await openSettings(DEFAULT_SETTINGS);
    $<HTMLInputElement>("key-deepgram").value = "dg-typed";
    $<HTMLTextAreaElement>("custom-vocabulary").value = "Kubernetes\nAcme";

    $("tier-budget").click();
    $<HTMLInputElement>("key-groq").value = "groq-typed";
    $("tier-default").click();
    expect($<HTMLInputElement>("key-deepgram").value).toBe("dg-typed");
    $("tier-budget").click();
    expect($<HTMLInputElement>("key-groq").value).toBe("groq-typed");

    expect($<HTMLTextAreaElement>("custom-vocabulary").value).toBe("Kubernetes\nAcme");
  });

  it("keeps a half-typed webapp pair, opens Integrations, and shows an inline error instead of saving it as null", async () => {
    await openSettings(DEFAULT_SETTINGS);
    $<HTMLInputElement>("webapp-url").value = "https://app.example.com";
    chromeMock.runtime.sendMessage.mockClear();

    $("save-settings").click();

    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect($("webapp-token-error").textContent).toMatch(/access token/i);
    expect($("webapp-token").getAttribute("aria-invalid")).toBe("true") ;
    expect($<HTMLDetailsElement>("integrations").open).toBe(true);
    expect($<HTMLInputElement>("webapp-url").value).toBe("https://app.example.com");
    expect($("save-status").className).toContain("invalid");
  });

  it("saves a valid webapp pair and a cleared one", async () => {
    await openSettings(DEFAULT_SETTINGS);
    $<HTMLInputElement>("webapp-url").value = "https://app.example.com";
    $<HTMLInputElement>("webapp-token").value = "secret";
    $("save-settings").click();
    await vi.waitFor(() => expect(savedSettings()?.webapp).toEqual({ url: "https://app.example.com", token: "secret" }));
    // A second save while the first is still settling is ignored by design; wait for it to finish.
    await vi.waitFor(() => expect($("save-status").textContent).toContain("add Deepgram and Anthropic API keys before recording"));

    $<HTMLInputElement>("webapp-url").value = "";
    $<HTMLInputElement>("webapp-token").value = "";
    $("save-settings").click();
    await vi.waitFor(() => expect(savedSettings()?.webapp).toBeNull());
  });

  it("warns which provider keys are still required in your own-keys mode", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect($("provider-key-warning").textContent).toContain("Deepgram and Anthropic API keys before recording");

    $<HTMLInputElement>("key-deepgram").value = "deepgram-test-key";
    $<HTMLInputElement>("key-deepgram").dispatchEvent(new Event("input"));
    expect($("provider-key-warning").textContent).toContain("Anthropic API key before recording");
    expect($("provider-key-warning").textContent).not.toContain("Deepgram");
  });

  it("does not undo a Drive connection or consent made elsewhere while this page was open", async () => {
    await openSettings(DEFAULT_SETTINGS);
    // Another page connected Drive and the user acknowledged consent after this page loaded.
    await saveSettings({ ...DEFAULT_SETTINGS, consentDisclosureAcknowledged: true, onboardingComplete: true, drive: { clientId: "c", accessToken: "t", expiresAt: 1 } });

    $("save-settings").click();

    await vi.waitFor(() => expect(savedSettings()).toBeDefined());
    expect(savedSettings()?.drive).toEqual({ clientId: "c", accessToken: "t", expiresAt: 1 });
    expect(savedSettings()?.consentDisclosureAcknowledged).toBe(true);
    expect(savedSettings()?.onboardingComplete).toBe(true);
  });

  it("preserves saved history connection and selects API key processing", async () => {
    await openSettings({ ...hosted, webapp: { url: "https://app.example.com", token: "keep" } });
    $("save-settings").click();
    await vi.waitFor(() => expect(savedSettings()).toBeDefined());
    expect(savedSettings()?.webapp).toEqual({ url: "https://app.example.com", token: "keep" });
    expect(savedSettings()?.processingMode.kind).toBe("local_byok");
  });
});
