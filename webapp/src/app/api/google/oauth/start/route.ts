import { NextResponse } from "next/server";
import { publicUrl } from "@/lib/publicUrl";
import { safeNextPath } from "@/lib/navigation";
import { createSignInState, googleOAuthConfigured, sealOAuthState } from "@/lib/googleIntegration";
import { loginUrl } from "@/app/login/url";
import { OAUTH_STATE_COOKIE } from "../stateCookie";
import { managedExtensionOrigin } from "@/lib/cors";

function validExtensionRedirect(value: string | null): value is string {
  if (!value) return false;
  try {
    const redirect = new URL(value);
    const extensionId = new URL(managedExtensionOrigin()).host;
    return redirect.protocol === "https:" &&
      redirect.hostname === `${extensionId}.chromiumapp.org` &&
      redirect.pathname === "/hosted-auth" &&
      redirect.port === "" && redirect.username === "" && redirect.password === "" &&
      redirect.search === "" && redirect.hash === "";
  } catch {
    return false;
  }
}

/**
 * Starts "Continue with Google" for the sign-in and sign-up tabs. Reachable
 * without a session by design (see proxy.ts); it only ever redirects to
 * Google with an encrypted, single-use PKCE state — no user data is read.
 * Sign-up needs the terms tick captured here, before leaving for Google.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") === "signup" ? "signup" : "signin";
  const extensionClient = params.get("client") === "extension";
  const next = safeNextPath(params.get("next") || "/meetings");
  const tab = mode === "signup" ? "signup" : undefined;
  const back = (error: string) => NextResponse.redirect(publicUrl(loginUrl({ tab, error, next }), request));

  let extension: { redirectUri: string; codeChallenge: string; clientState: string } | undefined;
  if (extensionClient) {
    const redirectUri = params.get("redirect_uri");
    const codeChallenge = params.get("code_challenge") ?? "";
    const clientState = params.get("client_state") ?? "";
    // Chrome's identity redirect is derived from this extension's ID. Never
    // accept an arbitrary redirect URL, even when the caller is the extension.
    if (mode !== "signin" || !validExtensionRedirect(redirectUri) || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) || !/^[A-Za-z0-9_-]{16,128}$/u.test(clientState)) {
      return back("google-failed");
    }
    extension = { redirectUri, codeChallenge, clientState };
  }

  if (mode === "signup" && params.get("acceptTerms") !== "on") return back("consent-required");
  if (!googleOAuthConfigured()) return back("google-unavailable");
  try {
    const { state, authorizationUrl } = createSignInState({
      mode,
      next,
      termsAccepted: mode === "signup",
      workspaceName: mode === "signup" ? (params.get("workspaceName") ?? "").slice(0, 100) : undefined,
      ...(extension ? { extension } : {}),
    });
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OAUTH_STATE_COOKIE, sealOAuthState(state), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google/oauth",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    return back("google-unavailable");
  }
}
