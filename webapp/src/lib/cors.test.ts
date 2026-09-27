import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_EXTENSION_ORIGIN, managedCorsHeaders, managedExtensionOrigin } from "./cors";

describe("managed CORS policy", () => {
  it("uses the fixed extension origin by default", () => {
    expect(managedExtensionOrigin({})).toBe(DEFAULT_MANAGED_EXTENSION_ORIGIN);
  });

  it("accepts an explicitly configured browser-extension origin", () => {
    expect(managedExtensionOrigin({ MANAGED_EXTENSION_ORIGIN: "chrome-extension://custom-extension/" })).toBe("chrome-extension://custom-extension");
    expect(managedExtensionOrigin({ MANAGED_EXTENSION_ORIGIN: "https://evil.example/" })).toBe(DEFAULT_MANAGED_EXTENSION_ORIGIN);
  });

  it("does not emit wildcard access for an untrusted origin", () => {
    const headers = managedCorsHeaders("https://evil.example", "https://notes.example");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
  });
});
