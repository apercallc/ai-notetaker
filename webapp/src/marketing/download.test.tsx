import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { DownloadView } from "./Views";

const storeUrl = process.env.CHROME_WEB_STORE_URL;
afterEach(() => {
  if (storeUrl === undefined) delete process.env.CHROME_WEB_STORE_URL;
  else process.env.CHROME_WEB_STORE_URL = storeUrl;
});

it("keeps a real release destination when GitHub links cannot be loaded", () => {
  delete process.env.CHROME_WEB_STORE_URL;
  const html = renderToStaticMarkup(<DownloadView release={null} />);
  expect(html).toContain('href="https://github.com/apercallc/ai-notetaker/releases/latest"');
  expect(html).toContain("Record browser or desktop meetings.");
  expect(html).toContain("Release links could not be loaded.");
  expect(html).toContain("View all releases");
  expect(html).toContain("Chrome extension for browser meetings");
  expect(html).toContain("Already use the previous extension and helper setup?");
  expect(html).not.toContain("Not published yet");
  expect(html).not.toContain("Add to Chrome");
});

it("shows direct desktop downloads and extension capture when installers are published", () => {
  const html = renderToStaticMarkup(<DownloadView platform="macos" release={{
    tag: "v1.0.0",
    pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0",
    mac: { name: "app.dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.dmg", bytes: 100 },
    macIntel: { name: "app-x86_64.dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app-x86_64.dmg", bytes: 100 },
  }} />);
  expect(html).toContain('href="https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.dmg"');
  const desktopSection = html.split('<details id="legacy-downloads"')[0];
  expect(desktopSection).toContain("Download AI Notetaker");
  expect(desktopSection).toContain("Installer not published yet.");
  expect(desktopSection).toContain("Preview release.");
  expect(desktopSection).toContain("These installers are unsigned");
  expect(desktopSection).toContain('aria-label="Download installer for macOS · Apple silicon"');
  expect(desktopSection).toContain('href="https://github.com/apercallc/ai-notetaker/blob/main/docs/launch/release-candidate-checklist.md"');
  expect(desktopSection).toContain("Download installer");
  expect(desktopSection).toContain("Raw recordings are saved on this device before processing.");
  expect(desktopSection).toContain("audio is sent directly to your chosen transcription provider");
  expect(desktopSection).toContain("the resulting transcript is sent to your chosen summary provider");
  expect(desktopSection).toContain("Install on macOS · Apple silicon");
  expect(desktopSection).toContain("Open Anyway");
  expect(desktopSection).toContain("macOS · Intel");
  expect(desktopSection).toContain('href="https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app-x86_64.dmg"');
  expect(desktopSection).toContain("No AI Notetaker account is needed.");
  expect(desktopSection).toContain("Capture meeting audio playing in the current secure Chrome tab");
  expect(desktopSection).not.toContain("install-native-messaging.sh");
  expect(desktopSection).not.toContain("Check desktop helper");
  expect(desktopSection).toMatch(/class="mk-btn mk-btn--solid"[^>]*href="https:\/\/github.com\/apercallc\/ai-notetaker\/releases\/download\/v1\.0\.0\/app\.dmg"/);
});

it("links to the release page when a release has no desktop installer", () => {
  const html = renderToStaticMarkup(<DownloadView platform="macos" release={{
    tag: "v1.0.0",
    pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0",
    extension: { name: "ai-notetaker-extension-v1.0.0.zip", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/extension.zip", bytes: 100 },
  }} />);
  expect(html).toContain("This release has no desktop installer attached. Check its release page for available assets.");
  expect(html).toContain('href="https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0"');
  expect(html).not.toContain("Download for macOS · Apple silicon");
});

it("offers Windows and Linux installers with matching setup guidance", () => {
  const html = renderToStaticMarkup(<DownloadView platform="windows" release={{
    tag: "v1.0.0",
    pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0",
    windows: { name: "AI.Notetaker_1.0.0_x64-setup.exe", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.exe", bytes: 100 },
    linux: { name: "ai-notetaker_1.0.0_amd64.deb", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.deb", bytes: 100 },
  }} />);
  const desktopSection = html.split('<details id="legacy-downloads"')[0];
  expect(desktopSection).toContain('href="https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.exe"');
  expect(desktopSection).toContain('href="https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.deb"');
  expect(desktopSection).toContain("Install on Windows · 64-bit");
  expect(desktopSection).toContain("Install on Linux · Debian or Ubuntu");
  expect(desktopSection).toMatch(/<details open=""><summary>Install on Windows · 64-bit/);
});

it("keeps legacy extension downloads collapsed, including desktop query links", () => {
  const defaultHtml = renderToStaticMarkup(<DownloadView release={null} />);
  expect(defaultHtml).toMatch(/<details id="legacy-downloads" class="mk-wrap mk-legacy-downloads">/);
  expect(defaultHtml).toContain("Capture meeting audio playing in the current secure Chrome tab");
  expect(defaultHtml).toContain("previous extension and helper setup");
  expect(defaultHtml).toContain("Use my own API keys");
  expect(defaultHtml).toContain("does not require an AI Notetaker account or Hosted AI sign-in");
  expect(defaultHtml).not.toContain("choose <strong>Hosted AI</strong> and sign in");
});
