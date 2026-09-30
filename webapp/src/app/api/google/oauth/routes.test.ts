import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookies, getSessionContext, createOAuthState, sealOAuthState, completeOAuthConnection, oauthStateMatches, openOAuthState } = vi.hoisted(() => ({
  cookies: vi.fn(),
  getSessionContext: vi.fn(),
  createOAuthState: vi.fn(),
  sealOAuthState: vi.fn(),
  completeOAuthConnection: vi.fn(),
  oauthStateMatches: vi.fn(),
  openOAuthState: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/lib/sessions", () => ({ getSessionContext }));
vi.mock("@/lib/googleIntegration", () => ({
  createOAuthState,
  sealOAuthState,
  completeOAuthConnection,
  oauthStateMatches,
  openOAuthState,
  GoogleIntegrationError: class GoogleIntegrationError extends Error {
    constructor(publicMessage: string) { super(publicMessage); }
  },
}));

import { GET as connect } from "./connect/route";
import { GET as callback } from "./callback/route";

const state = { userId: "user-1", state: "state-1", verifier: "private-verifier", expiresAt: Date.now() + 10_000 };
const session = { user: { id: "user-1", mustChangePassword: false } };
let cookieValues: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  cookieValues = {};
  cookies.mockResolvedValue({ get: (key: string) => cookieValues[key] ? { value: cookieValues[key] } : undefined });
  getSessionContext.mockResolvedValue(session);
  createOAuthState.mockReturnValue({ state, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=state-1" });
  sealOAuthState.mockReturnValue("sealed-state");
  openOAuthState.mockReturnValue(state);
  oauthStateMatches.mockImplementation((expected: string, received: string | null) => expected === received);
  completeOAuthConnection.mockResolvedValue(undefined);
});

describe("Google OAuth connect route", () => {
  it("sends anonymous users to sign-in and blocks temporary-password accounts", async () => {
    getSessionContext.mockResolvedValueOnce(null);
    const anonymous = await connect(new Request("https://app.example.com/api/google/oauth/connect"));
    expect(anonymous.headers.get("location")).toContain("/login?next=/account");

    getSessionContext.mockResolvedValueOnce({ user: { id: "user-1", mustChangePassword: true } });
    const forcedChange = await connect(new Request("https://app.example.com/api/google/oauth/connect"));
    expect(forcedChange.headers.get("location")).toContain("/account?required=1");
    expect(createOAuthState).not.toHaveBeenCalled();
  });

  it("redirects to Google and keeps the PKCE state encrypted in a scoped HttpOnly cookie", async () => {
    const response = await connect(new Request("https://app.example.com/api/google/oauth/connect"));
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=state-1");
    expect(sealOAuthState).toHaveBeenCalledWith(state);
    const cookie = response.cookies.get("google_oauth_state");
    expect(cookie?.value).toBe("sealed-state");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/google/oauth", maxAge: 600 });
  });

  it("returns safe account guidance when OAuth setup fails", async () => {
    createOAuthState.mockImplementation(() => { throw new Error("private configuration detail"); });
    const response = await connect(new Request("https://app.example.com/api/google/oauth/connect"));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("googleError")).toBe("Google integration is unavailable. Try again later.");
  });
});

describe("Google OAuth callback route", () => {
  it("rejects missing or mismatched session state and clears the one-time cookie", async () => {
    getSessionContext.mockResolvedValueOnce(null);
    cookieValues.google_oauth_state = "sealed-state";
    const noSession = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=state-1"));
    expect(noSession.headers.get("location")).toContain("Google+authorization+could+not+be+verified");
    expect(noSession.cookies.get("google_oauth_state")?.maxAge).toBe(0);

    const badState = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=other"));
    expect(badState.headers.get("location")).toContain("Google+authorization+could+not+be+verified");
    expect(completeOAuthConnection).not.toHaveBeenCalled();
  });

  it("handles denied authorization and a missing code without calling the token exchange", async () => {
    cookieValues.google_oauth_state = "sealed-state";
    const denied = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=state-1&error=access_denied"));
    expect(denied.headers.get("location")).toContain("Google+authorization+was+cancelled+or+denied");
    const noCode = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=state-1"));
    expect(noCode.headers.get("location")).toContain("Google+did+not+return+an+authorization+code");
    expect(completeOAuthConnection).not.toHaveBeenCalled();
  });

  it("completes the connection and removes state after a valid callback", async () => {
    cookieValues.google_oauth_state = "sealed-state";
    const response = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=state-1&code=auth-code"));
    expect(response.headers.get("location")).toBe("https://app.example.com/account?google=connected");
    expect(completeOAuthConnection).toHaveBeenCalledWith("user-1", "auth-code", state);
    expect(response.cookies.get("google_oauth_state")?.maxAge).toBe(0);
  });

  it("uses a safe message if token exchange fails", async () => {
    cookieValues.google_oauth_state = "sealed-state";
    completeOAuthConnection.mockRejectedValue(new Error("token contains private provider detail"));
    const response = await callback(new Request("https://app.example.com/api/google/oauth/callback?state=state-1&code=auth-code"));
    expect(response.headers.get("location")).toContain("Google+connection+could+not+be+saved");
    expect(response.headers.get("location")).not.toContain("private+provider+detail");
  });
});

describe("redirects behind the platform proxy", () => {
  const original = { managed: process.env.MANAGED_HOSTING, url: process.env.APP_URL };
  const internal = "https://0.0.0.0:8080/api/google/oauth";

  beforeEach(() => {
    process.env.MANAGED_HOSTING = "true";
    process.env.APP_URL = "https://public.example.test";
  });

  function restore(): void {
    if (original.managed === undefined) delete process.env.MANAGED_HOSTING; else process.env.MANAGED_HOSTING = original.managed;
    if (original.url === undefined) delete process.env.APP_URL; else process.env.APP_URL = original.url;
  }

  it("returns the user to the public origin, never the server's internal address, after Google approves", async () => {
    try {
      cookieValues.google_oauth_state = "sealed-state";
      const response = await callback(new Request(`${internal}/callback?state=state-1&code=auth-code`));
      expect(response.headers.get("location")).toBe("https://public.example.test/account?google=connected");
    } finally { restore(); }
  });

  it("also uses the public origin for errors and for signed-out visitors", async () => {
    try {
      const denied = await callback(new Request(`${internal}/callback?state=state-1&error=access_denied`));
      expect(new URL(denied.headers.get("location")!).origin).toBe("https://public.example.test");
      getSessionContext.mockResolvedValueOnce(null);
      const anonymous = await connect(new Request(`${internal}/connect`));
      expect(anonymous.headers.get("location")).toBe("https://public.example.test/login?next=/account");
    } finally { restore(); }
  });

  it("falls back to the request's origin if APP_URL is unusable, instead of failing the redirect", async () => {
    try {
      process.env.APP_URL = "not a url";
      getSessionContext.mockResolvedValueOnce(null);
      const response = await connect(new Request("https://fallback.example.test/api/google/oauth/connect"));
      expect(response.headers.get("location")).toBe("https://fallback.example.test/login?next=/account");
    } finally { restore(); }
  });
});
