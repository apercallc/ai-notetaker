import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

describe("manifest.json cross-browser fields", () => {
  it("uses the product name in Chrome's full and compact labels", () => {
    expect(manifest.name).toBe("AI Notetaker");
    expect(manifest.short_name).toBe("AI Notetaker");
  });

  it("declares a permanent Firefox gecko extension id", () => {
    expect(manifest.browser_specific_settings?.gecko?.id).toBe("notetaker@apercallc.dev");
  });

  it("declares background.scripts for Firefox alongside service_worker for Chrome/Edge/Brave", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toEqual(["background.js"]);
  });

  it("injects the Meet widget only on meet.google.com, with capture kept to that host", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0]?.matches).toEqual(["https://meet.google.com/*"]);
    expect(manifest.content_scripts[0]?.js).toEqual(["content/meetWidget.js"]);
    expect(manifest.host_permissions).toEqual(["https://meet.google.com/*"]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "https://api.deepgram.com/*",
      "https://api.groq.com/*",
      "https://api.anthropic.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://api.deepseek.com/*",
    ]);
  });

  it("registers the two Meet shortcuts the widget advertises", () => {
    expect(manifest.commands["toggle-recording"]?.suggested_key.default).toBe("Alt+Shift+R");
    expect(manifest.commands["add-bookmark"]?.suggested_key.default).toBe("Alt+Shift+B");
  });

  it("keeps the committed extension key", () => {
    expect(manifest.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4K2Qmk5R/);
  });

  it("asks only for the permissions the features need", () => {
    expect([...manifest.permissions].sort()).toEqual(
      ["activeTab", "clipboardWrite", "notifications", "offscreen", "storage", "tabCapture", "unlimitedStorage"].sort(),
    );
    expect([...manifest.optional_permissions].sort()).toEqual(["alarms", "identity", "nativeMessaging"].sort());
    expect(manifest.host_permissions).toContain("https://meet.google.com/*");
    expect(manifest.host_permissions).not.toContain("https://api.deepgram.com/*");
  });
});
