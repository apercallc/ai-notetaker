import { afterEach, describe, expect, it } from "vitest";
import { createOAuthState, googleOAuthConfigured, oauthStateMatches, openOAuthState, sealOAuthState } from "./googleIntegration";

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
