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

describe("settings page: modes", () => {
  it("opens on Hosted for a signed-in hosted user and never presents your own keys as active", async () => {
    await openSettings(hosted);

    expect($("mode-managed").getAttribute("aria-pressed")).toBe("true");
    expect($("mode-local").getAttribute("aria-pressed")).toBe("false");
    expect(document.getElementById("key-deepgram")).toBeNull();
    expect(document.getElementById("meeting-minutes")).toBeNull();
    expect(document.getElementById("managed-sign-out")).not.toBeNull();
    expect(document.getElementById("managed-sign-in")).toBeNull();
  });

  it("uses one vocabulary: 'Your own API keys (free)' and 'Hosted (paid)', never BYOK or managed", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect($("mode-local").textContent).toBe("Your own API keys (free)");
    expect($("mode-managed").textContent).toBe("Hosted (paid)");
    expect(document.body.textContent).not.toMatch(/BYOK|managed/i);

    $("mode-managed").click();
    expect(document.body.textContent).not.toMatch(/BYOK|managed/i);
  });

  it("shows the sign-in form only when Hosted is selected", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect(document.getElementById("managed-email")).toBeNull();

    $("mode-managed").click();
    expect(document.getElementById("managed-email")).not.toBeNull();
    $("mode-local").click();
    expect(document.getElementById("managed-email")).toBeNull();
  });

  it("hides the self-hosted webapp in Hosted mode and keeps the cost estimator to your own keys", async () => {
    await openSettings(DEFAULT_SETTINGS);
    expect(document.getElementById("webapp-url")).not.toBeNull();
    expect(document.getElementById("meeting-minutes")).not.toBeNull();

    $("mode-managed").click();
    expect(document.getElementById("webapp-url")).toBeNull();
    expect(document.getElementById("meeting-minutes")).toBeNull();
  });

  it("switching modes keeps the hosted session; only the separate Sign out button removes it", async () => {
    await openSettings(hosted);
    $("mode-local").click();
    expect(document.getElementById("key-deepgram")).not.toBeNull();
    $("mode-managed").click();
    expect(document.getElementById("managed-sign-out")).not.toBeNull();

    $("managed-sign-out").click();
    await vi.waitFor(() => expect(document.getElementById("managed-sign-in")).not.toBeNull());
    expect(savedSettings()?.managedService).toBeNull();
    expect(savedSettings()?.processingMode).toEqual({ kind: "local_byok" });
    expect($<HTMLInputElement>("managed-email").value).toBe("");
    expect($("mode-managed").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("settings page: structure", () => {
  it("keeps all optional connections collapsed and removes browser OAuth-client setup", async () => {
    await openSettings(DEFAULT_SETTINGS);
    const legends = [...document.querySelectorAll("legend")].map((legend) => legend.textContent);
    expect(legends).toEqual(["How meetings are processed", "Notes preferences", "Shortcuts and Meet widget"]);

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
  it("keeps typed keys, vocabulary and hosted email across toggles and tier switches", async () => {
    await openSettings(DEFAULT_SETTINGS);
    $<HTMLInputElement>("key-deepgram").value = "dg-typed";
    $<HTMLTextAreaElement>("custom-vocabulary").value = "Kubernetes\nAcme";

    $("tier-budget").click();
    $<HTMLInputElement>("key-groq").value = "groq-typed";
    $("tier-default").click();
    expect($<HTMLInputElement>("key-deepgram").value).toBe("dg-typed");
    $("tier-budget").click();
    expect($<HTMLInputElement>("key-groq").value).toBe("groq-typed");

    $("mode-managed").click();
    $<HTMLInputElement>("managed-email").value = "me@example.com";
    $("mode-local").click();
    $("mode-managed").click();
    expect($<HTMLInputElement>("managed-email").value).toBe("me@example.com");
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

    $<HTMLInputElement>("webapp-url").value = "";
    $<HTMLInputElement>("webapp-token").value = "";
    $("save-settings").click();
    await vi.waitFor(() => expect(savedSettings()?.webapp).toBeNull());
  });

  it("leaves a saved webapp connection untouched when saving in Hosted mode", async () => {
    await openSettings({ ...hosted, webapp: { url: "https://app.example.com", token: "keep" } });
    $("save-settings").click();
    await vi.waitFor(() => expect(savedSettings()).toBeDefined());
    expect(savedSettings()?.webapp).toEqual({ url: "https://app.example.com", token: "keep" });
    expect(savedSettings()?.processingMode.kind).toBe("managed");
  });
});
