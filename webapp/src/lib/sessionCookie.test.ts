import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));

import { clearSessionCookie, cookiesLikelyDropped, SESSION_COOKIE, setSessionCookie, shouldUseSecureCookies } from "./sessionCookie";

const saved = {
  appUrl: process.env.APP_URL,
  publicAppUrl: process.env.NEXT_PUBLIC_APP_URL,
  insecure: process.env.INSECURE_COOKIES,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.INSECURE_COOKIES;
});

afterAll(() => {
  for (const [name, value] of Object.entries({
    APP_URL: saved.appUrl,
    NEXT_PUBLIC_APP_URL: saved.publicAppUrl,
    INSECURE_COOKIES: saved.insecure,
    NODE_ENV: saved.nodeEnv,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("secure cookie policy", () => {
  it("uses trusted deployment configuration and never lets forwarded protocol downgrade Secure", () => {
    process.env.APP_URL = " https://app.example.com/path ";
    expect(shouldUseSecureCookies({ host: "app.example.com", protocol: "http" })).toBe(true);
    expect(cookiesLikelyDropped({ host: "app.example.com", protocol: "http" })).toBe(true);
    expect(cookiesLikelyDropped({ host: "app.example.com", protocol: "https" })).toBe(false);
    process.env.APP_URL = "http://app.example.com";
    expect(shouldUseSecureCookies({ host: "app.example.com", protocol: "https" })).toBe(false);
    expect(cookiesLikelyDropped({ host: "app.example.com", protocol: null })).toBe(false);
  });

  it("handles localhost, explicit opt-out, fallback URLs, and production fail-safe", () => {
    process.env.APP_URL = "not a url";
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example.com";
    expect(shouldUseSecureCookies({ host: "localhost:3000", protocol: "https" })).toBe(false);
    expect(shouldUseSecureCookies({ host: "127.0.0.1:3000", protocol: "https" })).toBe(false);
    expect(shouldUseSecureCookies({ host: "dev.localhost", protocol: "https" })).toBe(false);
    expect(shouldUseSecureCookies({ host: "[::1]:3000", protocol: "https" })).toBe(false);
    expect(shouldUseSecureCookies({ host: null, protocol: null })).toBe(false);
    delete process.env.APP_URL;
    expect(shouldUseSecureCookies({ host: "public.example.com", protocol: null })).toBe(true);
    process.env.INSECURE_COOKIES = "true";
    expect(shouldUseSecureCookies({ host: "public.example.com", protocol: "https" })).toBe(false);
    expect(cookiesLikelyDropped({ host: "public.example.com", protocol: "http" })).toBe(false);
  });

  it("sets an HttpOnly session cookie with safe defaults and can clear it", async () => {
    const store = { set: vi.fn(), delete: vi.fn() };
    cookies.mockResolvedValue(store);
    const expiresAt = new Date("2026-10-01T00:00:00.000Z");
    await setSessionCookie({ id: "session-id", expiresAt }, { host: "app.example.com", protocol: "https" });
    expect(store.set).toHaveBeenCalledWith(SESSION_COOKIE, "session-id", {
      httpOnly: true, sameSite: "lax", secure: true, path: "/", expires: expiresAt,
    });
    await clearSessionCookie();
    expect(store.delete).toHaveBeenCalledWith(SESSION_COOKIE);
  });
});
