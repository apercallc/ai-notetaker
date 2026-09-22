import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { estimateMeetingCost } from "../src/lib/costEstimate";
import { escapeHtml } from "../src/lib/html";
import { detectInstallPlatform, getInstallPageUrl } from "../src/lib/install";
import { testProviderKey } from "../src/lib/testProviderKey";

describe("small deterministic extension utilities", () => {
  it("estimates only positive finite meeting durations", () => {
    expect(estimateMeetingCost("default", 45)).toBe(0.21);
    expect(estimateMeetingCost("budget", 90)).toBe(0.06);
    expect(estimateMeetingCost("default", 0)).toBe(0);
    expect(estimateMeetingCost("default", Number.NaN)).toBe(0);
  });

  it("escapes untrusted text before HTML insertion", () => {
    expect(escapeHtml(`<img src=x onerror="bad">`)).toContain("&lt;img");
  });

  it("builds an install URL with detected platform and source", () => {
    expect(["macos", "windows", "linux", "unknown"]).toContain(detectInstallPlatform());
    const url = new URL(getInstallPageUrl("popup"));
    expect(url.origin).toBe("https://apercallc.github.io");
    expect(url.searchParams.get("source")).toBe("popup");
    expect(url.searchParams.get("platform")).toBeTruthy();
  });

  describe("testProviderKey", () => {
    beforeEach(() => {
      chromeMock.runtime.sendMessage = vi.fn().mockResolvedValue({ valid: true, message: "ok" });
    });

    it("rejects an empty key locally", async () => {
      await expect(testProviderKey("deepgram", "  ")).resolves.toEqual({ valid: false, message: "Enter an API key first." });
      expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("routes a non-empty key through the background worker", async () => {
      await expect(testProviderKey("claude", "secret")).resolves.toEqual({ valid: true, message: "ok" });
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "TEST_PROVIDER_KEY", provider: "claude", key: "secret" });
    });
  });
});
