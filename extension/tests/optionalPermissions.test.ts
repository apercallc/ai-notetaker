import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "./setup";
import {
  hasOptionalPermission,
  providerHostPermission,
  providerHostPermissions,
  providerPermissionName,
  requestDesktopHelperPermissions,
  requestLegacyGoogleIdentityPermission,
  requestOptionalPermission,
} from "../src/lib/optionalPermissions";

beforeEach(() => chromeMock.reset());

describe("optional extension permissions", () => {
  it("can check an already granted permission without prompting", async () => {
    chromeMock.permissions.contains.mockResolvedValue(true);
    expect(await hasOptionalPermission({ permissions: ["identity"] })).toBe(true);
    expect(chromeMock.permissions.request).not.toHaveBeenCalled();
  });

  it("requests only the origins for the selected providers", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    expect(providerHostPermission("deepgram")).toEqual({ origins: ["https://api.deepgram.com/*"] });
    expect(providerHostPermissions(["groq", "gemini", "groq"])).toEqual({
      origins: ["https://api.groq.com/*", "https://generativelanguage.googleapis.com/*"],
    });
    expect(providerPermissionName("claude")).toBe("Anthropic");
    expect(await requestOptionalPermission(providerHostPermission("deepgram"))).toBe(true);
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ["https://api.deepgram.com/*"] });
  });

  it("returns false on denial and surfaces permission API failures", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(false);
    expect(await requestOptionalPermission({ permissions: ["alarms"] })).toBe(false);
    chromeMock.permissions.request.mockRejectedValueOnce(new Error("permissions API failed"));
    await expect(requestOptionalPermission({ permissions: ["alarms"] })).rejects.toThrow("permissions API failed");
  });

  it("requests helper permissions only when the desktop flow asks", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    expect(await requestDesktopHelperPermissions()).toEqual({ nativeMessaging: true, alarms: true });
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ permissions: ["nativeMessaging", "alarms"] });
    chromeMock.permissions.contains.mockResolvedValue(false);
    expect(await requestLegacyGoogleIdentityPermission()).toBe(true);
    expect(chromeMock.permissions.request).toHaveBeenLastCalledWith({ permissions: ["identity"] });
  });

  it("keeps the helper usable if the user grants Native Messaging but declines retry alarms", async () => {
    chromeMock.permissions.request.mockResolvedValue(false);
    chromeMock.permissions.contains.mockImplementation(async (request) => request.permissions?.includes("nativeMessaging") ?? false);
    expect(await requestDesktopHelperPermissions()).toEqual({ nativeMessaging: true, alarms: false });
  });

  it("reports unavailable permissions APIs instead of pretending access exists", async () => {
    Object.assign(chromeMock, { permissions: undefined });
    expect(await hasOptionalPermission({ permissions: ["identity"] })).toBe(false);
    expect(await requestOptionalPermission({ permissions: ["identity"] })).toBe(false);
  });
});
