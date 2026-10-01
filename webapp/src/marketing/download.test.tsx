import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { DownloadView } from "./Views";

const storeUrl = process.env.CHROME_WEB_STORE_URL;
afterEach(() => {
  if (storeUrl === undefined) delete process.env.CHROME_WEB_STORE_URL;
  else process.env.CHROME_WEB_STORE_URL = storeUrl;
});

it("keeps a real download destination when the GitHub lookup fails", () => {
  delete process.env.CHROME_WEB_STORE_URL;
  const html = renderToStaticMarkup(<DownloadView release={null} />);
  expect(html).toContain('href="https://github.com/apercallc/ai-notetaker/releases/latest"');
  expect(html).toContain("All desktop downloads on GitHub");
  expect(html).not.toContain("Not published yet");
  expect(html).not.toContain("Add to Chrome");
});

it("links the published installer and opens the matching installation instructions", () => {
  const html = renderToStaticMarkup(<DownloadView platform="macos" release={{
    tag: "v1.0.0",
    pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0",
    mac: { name: "app.dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.dmg", bytes: 100 },
  }} />);
  expect(html).toContain('href="https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app.dmg"');
  expect(html).toMatch(/<details open=""><summary>macOS/);
  expect(html).toContain("install-native-messaging.sh");
  expect(html).toContain("Check desktop helper");
});

it("shows the guided steps only for a guided Mac installer asset", () => {
  const html = renderToStaticMarkup(<DownloadView platform="macos" release={{
    tag: "v1.0.0",
    pageUrl: "https://github.com/apercallc/ai-notetaker/releases/tag/v1.0.0",
    mac: { name: "AI.Notetaker_1.0.0_aarch64-installer.dmg", url: "https://github.com/apercallc/ai-notetaker/releases/download/v1.0.0/app-installer.dmg", bytes: 100 },
  }} />);
  expect(html).toContain("Install AI Notetaker.command");
  expect(html).toContain("A Terminal window opens");
  expect(html).toContain("not notarized by Apple");
  expect(html).not.toContain("install-native-messaging.sh");
});
