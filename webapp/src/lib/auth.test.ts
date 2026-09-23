import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isAuthorizedBearer, LOCAL_USER_ID } from "./auth";

const ORIGINAL_TOKEN = process.env.AUTH_TOKEN;

describe("isAuthorizedBearer", () => {
  beforeEach(() => {
    process.env.AUTH_TOKEN = "correct-token-value";
  });
  afterEach(() => {
    process.env.AUTH_TOKEN = ORIGINAL_TOKEN;
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedBearer(null)).toBe(false);
  });

  it("rejects a header that isn't a Bearer token", () => {
    expect(isAuthorizedBearer("Basic dXNlcjpwYXNz")).toBe(false);
  });

  it("rejects a Bearer token that doesn't match AUTH_TOKEN", () => {
    expect(isAuthorizedBearer("Bearer wrong-token")).toBe(false);
  });

  it("accepts a Bearer token that matches AUTH_TOKEN exactly", () => {
    expect(isAuthorizedBearer("Bearer correct-token-value")).toBe(true);
  });

  it("rejects everything if AUTH_TOKEN is unset (fail closed, never open)", () => {
    delete process.env.AUTH_TOKEN;
    expect(isAuthorizedBearer("Bearer anything")).toBe(false);
    expect(isAuthorizedBearer("Bearer ")).toBe(false);
  });

  it("rejects an empty-string token even if AUTH_TOKEN is also empty", () => {
    process.env.AUTH_TOKEN = "";
    expect(isAuthorizedBearer("Bearer ")).toBe(false);
  });
});

describe("LOCAL_USER_ID", () => {
  it("is a stable constant used for the single-user v1 scope", () => {
    expect(LOCAL_USER_ID).toBe("local");
  });
});
