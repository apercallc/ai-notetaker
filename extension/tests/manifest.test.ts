import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

describe("manifest.json cross-browser fields", () => {
  it("declares a permanent Firefox gecko extension id", () => {
    expect(manifest.browser_specific_settings?.gecko?.id).toBe("notetaker@apercallc.dev");
  });

  it("declares background.scripts for Firefox alongside service_worker for Chrome/Edge/Brave", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toEqual(["background.js"]);
  });
});
