import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookies, getSessionContext, createSession, resolveGoogleAccount, createSignInState, completeGoogleSignIn, googleOAuthConfigured, createOAuthState, sealOAuthState, completeOAuthConnection, oauthStateMatches, openOAuthState } = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveGoogleAccount: vi.fn(),
  createSignInState: vi.fn(),
  completeGoogleSignIn: vi.fn(),
  googleOAuthConfigured: vi.fn(),
  cookies: vi.fn(),
  getSessionContext: vi.fn(),
  createOAuthState: vi.fn(),
  sealOAuthState: vi.fn(),
  completeOAuthConnection: vi.fn(),
  oauthStateMatches: vi.fn(),
  openOAuthState: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/lib/sessions", () => ({ getSessionContext, createSession }));
vi.mock("@/lib/accounts", () => ({ resolveGoogleAccount }));
vi.mock("@/lib/googleIntegration", () => ({
  createSignInState,
  completeGoogleSignIn,
  googleOAuthConfigured,
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
import { GET as start } from "./start/route";

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

describe("Google sign-in start route", () => {
  beforeEach(() => {
    googleOAuthConfigured.mockReturnValue(true);
    createSignInState.mockReturnValue({ state: { ...state, userId: "", purpose: "signin" }, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=state-1" });
  });

  it("redirects to Google with sealed state, needing no session", async () => {
    const response = await start(new Request("https://app.example.com/api/google/oauth/start?mode=signin&next=/meetings/abc"));
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=state-1");
    expect(createSignInState).toHaveBeenCalledWith({ mode: "signin", next: "/meetings/abc", termsAccepted: false, workspaceName: undefined });
    expect(getSessionContext).not.toHaveBeenCalled();
    expect(response.cookies.get("google_oauth_state")).toMatchObject({ value: "sealed-state", httpOnly: true, sameSite: "lax", path: "/api/google/oauth" });
  });

  it("refuses sign-up without the terms tick and never contacts Google", async () => {
    const response = await start(new Request("https://app.example.com/api/google/oauth/start?mode=signup"));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("tab")).toBe("signup");
    expect(location.searchParams.get("error")).toBe("consent-required");
    expect(createSignInState).not.toHaveBeenCalled();
  });

  it("records the consent for sign-up and sanitizes next", async () => {
    await start(new Request("https://app.example.com/api/google/oauth/start?mode=signup&acceptTerms=on&next=//evil.example"));
    expect(createSignInState).toHaveBeenCalledWith(expect.objectContaining({ mode: "signup", termsAccepted: true, next: expect.not.stringContaining("evil") }));
  });

  it("falls back to the login page when Google is not configured", async () => {
    googleOAuthConfigured.mockReturnValue(false);
    const response = await start(new Request("https://app.example.com/api/google/oauth/start?mode=signin"));
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("google-unavailable");
  });
});

describe("Google sign-in callback", () => {
  const signinState = { userId: "", state: "state-1", verifier: "v", expiresAt: Date.now() + 10_000, purpose: "signin", next: "/meetings/abc" };

  beforeEach(() => {
    cookieValues.google_oauth_state = "sealed-state";
    getSessionContext.mockResolvedValue(null);
    openOAuthState.mockReturnValue(signinState);
    completeGoogleSignIn.mockResolvedValue({ email: "person@example.test", emailVerified: true });
    resolveGoogleAccount.mockResolvedValue({ ok: true, userId: "user-9", workspaceId: "ws-9", created: false, mustChangePassword: false });
    createSession.mockResolvedValue({ id: "session-id", expiresAt: new Date(Date.now() + 60_000) });
  });

  const call = (query = "state=state-1&code=auth-code") => callback(new Request(`https://app.example.com/api/google/oauth/callback?${query}`));

  it("creates a session cookie, clears the one-time state and lands on the requested page", async () => {
    const response = await call();
    expect(response.headers.get("location")).toBe("https://app.example.com/meetings/abc");
    expect(response.cookies.get("session")).toMatchObject({ value: "session-id", httpOnly: true, sameSite: "lax", path: "/" });
    expect(response.cookies.get("google_oauth_state")?.maxAge).toBe(0);
    expect(createSession).toHaveBeenCalledWith("user-9", expect.objectContaining({ activeWorkspaceId: "ws-9" }));
    expect(resolveGoogleAccount).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.test", emailVerified: true, mode: "signin", termsAccepted: false }));
  });

  it("does not need, and ignores, an existing session", async () => {
    getSessionContext.mockResolvedValue({ user: { id: "someone-else", mustChangePassword: false } });
    const response = await call();
    expect(createSession).toHaveBeenCalledWith("user-9", expect.anything());
    expect(response.headers.get("location")).toContain("/meetings/abc");
  });

  it("rejects a mismatched state before any token exchange", async () => {
    const response = await call("state=forged&code=auth-code");
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("google-failed");
    expect(completeGoogleSignIn).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(response.cookies.get("session")).toBeUndefined();
  });

  it("reports cancellation and a missing code without creating a session", async () => {
    const denied = await call("state=state-1&error=access_denied");
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("google-cancelled");
    const noCode = await call("state=state-1");
    expect(new URL(noCode.headers.get("location")!).searchParams.get("error")).toBe("google-failed");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("shows a safe error when the token exchange fails", async () => {
    completeGoogleSignIn.mockRejectedValue(new Error("secret provider detail"));
    const response = await call();
    expect(response.headers.get("location")).not.toContain("secret");
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("google-failed");
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each(["google-email-unverified", "google-account-unconfirmed", "signup-disabled"])("never signs in when the account rules refuse (%s)", async (error) => {
    resolveGoogleAccount.mockResolvedValue({ ok: false, error });
    const response = await call();
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(error);
    expect(createSession).not.toHaveBeenCalled();
    expect(response.cookies.get("session")).toBeUndefined();
  });

  it("sends a new Google user who used Sign in to the sign-up form, where consent is collected", async () => {
    resolveGoogleAccount.mockResolvedValue({ ok: false, error: "google-no-account" });
    const location = new URL((await call()).headers.get("location")!);
    expect(location.searchParams.get("tab")).toBe("signup");
    expect(location.searchParams.get("error")).toBe("google-no-account");
  });

  it("creates the account in sign-up mode with the consent captured before Google", async () => {
    openOAuthState.mockReturnValue({ ...signinState, purpose: "signup", termsAccepted: true, workspaceName: "Acme" });
    resolveGoogleAccount.mockResolvedValue({ ok: true, userId: "new-1", workspaceId: "ws-new", created: true, mustChangePassword: false });
    await call();
    expect(resolveGoogleAccount).toHaveBeenCalledWith(expect.objectContaining({ mode: "signup", termsAccepted: true, workspaceName: "Acme" }));
  });

  it("keeps the connect flow for legacy states without a purpose", async () => {
    openOAuthState.mockReturnValue(state);
    getSessionContext.mockResolvedValue(session);
    const response = await call();
    expect(response.headers.get("location")).toBe("https://app.example.com/account?google=connected");
    expect(completeGoogleSignIn).not.toHaveBeenCalled();
  });
});
