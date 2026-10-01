import { describe, expect, it } from "vitest";
import { resolveAccountTab } from "./tabs";

describe("resolveAccountTab", () => {
  it("defaults to security", () => expect(resolveAccountTab({})).toBe("security"));
  it("honors a valid tab", () => expect(resolveAccountTab({ tab: "data" })).toBe("data"));
  it("ignores an unknown tab", () => expect(resolveAccountTab({ tab: "nope" })).toBe("security"));
  it("routes Google results to integrations", () => {
    expect(resolveAccountTab({ google: "connected" })).toBe("integrations");
    expect(resolveAccountTab({ googleError: "x" })).toBe("integrations");
  });
  it("sends a forced password change to security", () => expect(resolveAccountTab({ required: "1", google: "connected" })).toBe("security"));
  it("lets an explicit tab beat redirect params", () => expect(resolveAccountTab({ tab: "danger", google: "connected" })).toBe("danger"));
});
