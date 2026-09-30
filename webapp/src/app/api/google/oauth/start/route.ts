import { NextResponse } from "next/server";
import { publicUrl } from "@/lib/publicUrl";
import { safeNextPath } from "@/lib/navigation";
import { createSignInState, googleOAuthConfigured, sealOAuthState } from "@/lib/googleIntegration";
import { loginUrl } from "@/app/login/url";
import { OAUTH_STATE_COOKIE } from "../stateCookie";

/**
 * Starts "Continue with Google" for the sign-in and sign-up tabs. Reachable
 * without a session by design (see proxy.ts); it only ever redirects to
 * Google with an encrypted, single-use PKCE state — no user data is read.
 * Sign-up needs the terms tick captured here, before leaving for Google.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") === "signup" ? "signup" : "signin";
  const next = safeNextPath(params.get("next") || "/meetings");
  const tab = mode === "signup" ? "signup" : undefined;
  const back = (error: string) => NextResponse.redirect(publicUrl(loginUrl({ tab, error, next }), request));

  if (mode === "signup" && params.get("acceptTerms") !== "on") return back("consent-required");
  if (!googleOAuthConfigured()) return back("google-unavailable");
  try {
    const { state, authorizationUrl } = createSignInState({
      mode,
      next,
      termsAccepted: mode === "signup",
      workspaceName: mode === "signup" ? (params.get("workspaceName") ?? "").slice(0, 100) : undefined,
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
