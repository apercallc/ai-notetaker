import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDriveDocumentUpload, completeGoogleSignIn, createOAuthState, createSignInState, GOOGLE_OAUTH_SCOPES, googleOAuthConfigured, oauthStateMatches, openOAuthState, sealOAuthState } from "./googleIntegration";

const original = {
  appUrl: process.env.APP_URL,
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  encryptionKey: process.env.GOOGLE_OAUTH_ENCRYPTION_KEY,
};

function restore(name: keyof typeof original, value: string | undefined): void {
  if (value === undefined) delete process.env[name === "appUrl" ? "APP_URL" : name === "clientId" ? "GOOGLE_OAUTH_CLIENT_ID" : name === "clientSecret" ? "GOOGLE_OAUTH_CLIENT_SECRET" : "GOOGLE_OAUTH_ENCRYPTION_KEY"];
  else process.env[name === "appUrl" ? "APP_URL" : name === "clientId" ? "GOOGLE_OAUTH_CLIENT_ID" : name === "clientSecret" ? "GOOGLE_OAUTH_CLIENT_SECRET" : "GOOGLE_OAUTH_ENCRYPTION_KEY"] = value;
}

afterEach(() => {
  restore("appUrl", original.appUrl);
  restore("clientId", original.clientId);
  restore("clientSecret", original.clientSecret);
  restore("encryptionKey", original.encryptionKey);
});

describe("server-owned Google OAuth configuration and state", () => {
  it("fails closed for missing or invalid encryption configuration", () => {
    process.env.APP_URL = "https://ai-notetaker.apercallc.com";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_OAUTH_ENCRYPTION_KEY = "too-short";
    expect(googleOAuthConfigured()).toBe(false);
    delete process.env.GOOGLE_OAUTH_ENCRYPTION_KEY;
    expect(googleOAuthConfigured()).toBe(false);
  });

  it("builds a PKCE authorization request and encrypts its one-time state", () => {
    process.env.APP_URL = "https://ai-notetaker.apercallc.com";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

    expect(googleOAuthConfigured()).toBe(true);
    const { state, authorizationUrl } = createOAuthState("user-123");
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe("https://ai-notetaker.apercallc.com/api/google/oauth/callback");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toContain("calendar.readonly");
    expect(authorization.searchParams.get("scope")).toContain("drive.file");

    const sealed = sealOAuthState(state);
    expect(sealed).not.toContain(state.verifier);
    expect(openOAuthState(sealed)).toEqual(state);
    expect(openOAuthState(`${sealed}tampered`)).toBeNull();
    expect(oauthStateMatches(state.state, state.state)).toBe(true);
    expect(oauthStateMatches(state.state, "different")).toBe(false);
  });
});

describe("Google scopes and Drive export upload", () => {
  it("requests only the scopes the product needs, and never the broad Docs scope", () => {
    expect(GOOGLE_OAUTH_SCOPES.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]);
    expect(GOOGLE_OAUTH_SCOPES).not.toContain("auth/documents");
  });

  it("builds one multipart upload that imports the notes as a Google Doc in the export folder", () => {
    const upload = buildDriveDocumentUpload("Weekly sync — 2026-09-30", "folder-1", "Decision: ship it\nLine with --boundary-like text");
    const boundary = /boundary=(.+)$/u.exec(upload.contentType)?.[1];
    expect(upload.contentType.startsWith("multipart/related; boundary=")).toBe(true);
    expect(boundary).toMatch(/^ainotetaker[0-9a-f]{24}$/u);

    const parts = upload.body.split(`--${boundary}`).map((part) => part.trim()).filter((part) => part && part !== "--");
    expect(parts).toHaveLength(2);
    const [metadataPart, contentPart] = parts;
    expect(metadataPart).toContain("Content-Type: application/json");
    expect(JSON.parse(metadataPart.split("\r\n\r\n")[1])).toEqual({
      name: "Weekly sync — 2026-09-30",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder-1"],
    });
    expect(contentPart).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(contentPart).toContain("Decision: ship it");
    expect(upload.body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("uses a fresh boundary every time so notes can never forge the part separator", () => {
    const first = buildDriveDocumentUpload("a", "f", "x").contentType;
    const second = buildDriveDocumentUpload("a", "f", "x").contentType;
    expect(first).not.toBe(second);
  });
});

describe("Google sign-in", () => {
  function configure(): void {
    process.env.APP_URL = "https://ai-notetaker.apercallc.com";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.GOOGLE_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks for identity only: no Calendar/Drive scope, no offline access, and the same callback URL", () => {
    configure();
    const { state, authorizationUrl } = createSignInState({ mode: "signup", next: "/meetings", termsAccepted: true, workspaceName: "Acme" });
    const params = new URL(authorizationUrl).searchParams;
    expect(params.get("scope")).toBe("openid email");
    expect(params.get("access_type")).toBeNull();
    expect(params.get("include_granted_scopes")).toBeNull();
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("redirect_uri")).toBe("https://ai-notetaker.apercallc.com/api/google/oauth/callback");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(state).toMatchObject({ purpose: "signup", userId: "", next: "/meetings", termsAccepted: true, workspaceName: "Acme" });
  });

  it("round-trips the sealed sign-in state and rejects an unknown purpose", () => {
    configure();
    const { state } = createSignInState({ mode: "signin" });
    expect(openOAuthState(sealOAuthState(state))).toMatchObject({ purpose: "signin" });
    expect(openOAuthState(sealOAuthState({ ...state, purpose: "admin" as never }))).toBeNull();
  });

  it("still requests Calendar and Drive for the Account connect flow", () => {
    configure();
    const { state, authorizationUrl } = createOAuthState("user-1");
    expect(state.purpose).toBe("connect");
    expect(new URL(authorizationUrl).searchParams.get("access_type")).toBe("offline");
  });

  it("returns the email and Google's verified flag without storing anything", async () => {
    configure();
    const { state } = createSignInState({ mode: "signin" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: "a@b.test", email_verified: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeGoogleSignIn("code", state)).resolves.toEqual({ email: "a@b.test", emailVerified: true });
    const tokenBody = String(fetchMock.mock.calls[0][1].body);
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).toContain("grant_type=authorization_code");
  });

  it("reports an unverified Google email as unverified, and fails safely without an email", async () => {
    configure();
    const { state } = createSignInState({ mode: "signin" });
    const tokens = () => new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(new Response(JSON.stringify({ email: "a@b.test", email_verified: false }), { status: 200 })));
    await expect(completeGoogleSignIn("code", state)).resolves.toMatchObject({ emailVerified: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })));
    await expect(completeGoogleSignIn("code", state)).rejects.toThrow();
  });
});
