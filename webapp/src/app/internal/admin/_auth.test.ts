import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { authorizeAdminRequest, decodeAdminCursor, encodeAdminCursor, isValidWindow } from "./_auth";

const envToken = process.env.AI_NOTETAKER_ADMIN_API_TOKEN;

afterEach(() => {
  if (envToken === undefined) delete process.env.AI_NOTETAKER_ADMIN_API_TOKEN;
  else process.env.AI_NOTETAKER_ADMIN_API_TOKEN = envToken;
});

describe("Aperca Admin API boundary", () => {
  it("denies absent, short, and incorrect service credentials", () => {
    delete process.env.AI_NOTETAKER_ADMIN_API_TOKEN;
    const request = () => new NextRequest("https://notes.example.com/internal/admin/users", { headers: { authorization: "Bearer wrong" } });
    expect(authorizeAdminRequest(request())?.status).toBe(401);
    process.env.AI_NOTETAKER_ADMIN_API_TOKEN = "short";
    expect(authorizeAdminRequest(request())?.status).toBe(401);
    process.env.AI_NOTETAKER_ADMIN_API_TOKEN = "a".repeat(40);
    expect(authorizeAdminRequest(request())?.status).toBe(401);
  });

  it("accepts a valid dedicated credential", () => {
    process.env.AI_NOTETAKER_ADMIN_API_TOKEN = "a".repeat(40);
    const request = new NextRequest("https://notes.example.com/internal/admin/users", { headers: { authorization: `Bearer ${"a".repeat(40)}` } });
    expect(authorizeAdminRequest(request)).toBeNull();
  });

  it("bounds requested metric windows and requires timezone offsets", () => {
    expect(isValidWindow("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).not.toBeNull();
    expect(isValidWindow("2026-10-01T00:00:00", "2026-10-02T00:00:00")).toBeNull();
    expect(isValidWindow("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z")).toBeNull();
    expect(isValidWindow("2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBeNull();
  });

  it("round trips cursors and rejects malformed cursor data", () => {
    const cursor = { id: "user-id", createdAt: new Date("2026-10-01T12:00:00.000Z") };
    expect(decodeAdminCursor(encodeAdminCursor(cursor))).toEqual(cursor);
    expect(decodeAdminCursor("not-base64-json")).toBeUndefined();
    expect(decodeAdminCursor("a".repeat(501))).toBeUndefined();
  });
});
