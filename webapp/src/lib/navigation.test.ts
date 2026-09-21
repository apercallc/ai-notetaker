import { describe, expect, it } from "vitest";
import { safeNextPath } from "./navigation";

describe("safeNextPath", () => {
  it("keeps an internal path and query string", () => {
    expect(safeNextPath("/meetings?page=2")).toBe("/meetings?page=2");
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(safeNextPath("//evil.example")).toBe("/meetings");
    expect(safeNextPath("https://evil.example")).toBe("/meetings");
  });

  it("rejects browser backslash normalization into an external host", () => {
    expect(safeNextPath("/\\\\evil.example")).toBe("/meetings");
  });

  it("falls back for missing or malformed values", () => {
    expect(safeNextPath(undefined)).toBe("/meetings");
    expect(safeNextPath("not-a-path")).toBe("/meetings");
  });
});
