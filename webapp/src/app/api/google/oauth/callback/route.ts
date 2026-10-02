import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionContext, createSession } from "@/lib/sessions";
import { publicUrl } from "@/lib/publicUrl";
import { safeNextPath } from "@/lib/navigation";
import { resolveGoogleAccount } from "@/lib/accounts";
import { contextFromRequest } from "@/lib/requestContext";
import { SESSION_COOKIE, shouldUseSecureCookies } from "@/lib/sessionCookie";
import { loginUrl } from "@/app/login/url";
import {
  completeGoogleSignIn,
  completeOAuthConnection,
  createGoogleExtensionCode,
  GoogleIntegrationError,
  oauthStateMatches,
  openOAuthState,
  type OAuthState,
} from "@/lib/googleIntegration";
import { OAUTH_STATE_COOKIE } from "../stateCookie";

function clearState(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, path: "/api/google/oauth", maxAge: 0 });
  return response;
}

function accountRedirect(request: Request, message?: string): NextResponse {
  const url = publicUrl("/account", request);
  if (message) url.searchParams.set("googleError", message);
  return clearState(NextResponse.redirect(url));
}

async function connectAccount(request: Request, state: OAuthState | null, code: string | null, stateParam: string | null, denied: boolean): Promise<NextResponse> {
  const store = await cookies();
  const session = await getSessionContext(store.get("session")?.value);
  if (!session || session.user.mustChangePassword || !state || state.userId !== session.user.id || !oauthStateMatches(state.state, stateParam)) {
    return accountRedirect(request, "Google authorization could not be verified. Try connecting again.");
  }
  if (denied) return accountRedirect(request, "Google authorization was cancelled or denied.");
  if (!code) return accountRedirect(request, "Google did not return an authorization code. Try connecting again.");
  try {
    await completeOAuthConnection(session.user.id, code, state);
    return clearState(NextResponse.redirect(publicUrl("/account?google=connected", request)));
  } catch (error) {
    return accountRedirect(request, error instanceof GoogleIntegrationError ? error.publicMessage : "Google connection could not be saved. Try again.");
  }
}

async function signInWithGoogle(request: Request, state: OAuthState, code: string | null, stateParam: string | null, denied: boolean): Promise<NextResponse> {
  const mode = state.purpose === "signup" ? "signup" : "signin";
  const tab = mode === "signup" ? "signup" : undefined;
  const next = safeNextPath(state.next || "/meetings");
  const fail = (error: string, extra: { retry?: number } = {}) =>
    clearState(NextResponse.redirect(publicUrl(loginUrl({ tab, error, next, ...extra }), request)));
  const extensionRedirect = (values: { code?: string; error?: string }) => {
    if (!state.extensionRedirectUri || !state.extensionClientState) return fail(values.error ?? "google-failed");
    const target = new URL(state.extensionRedirectUri);
    const fragment = new URLSearchParams({ state: state.extensionClientState });
    if (values.code) fragment.set("code", values.code);
    if (values.error) fragment.set("error", values.error);
    target.hash = fragment.toString();
    return clearState(NextResponse.redirect(target.toString()));
  };

  if (!oauthStateMatches(state.state, stateParam)) return state.extensionRedirectUri ? extensionRedirect({ error: "google-failed" }) : fail("google-failed");
  if (denied) return state.extensionRedirectUri ? extensionRedirect({ error: "google-cancelled" }) : fail("google-cancelled");
  if (!code) return state.extensionRedirectUri ? extensionRedirect({ error: "google-failed" }) : fail("google-failed");

  let identity;
  try {
    identity = await completeGoogleSignIn(code, state);
  } catch {
    return state.extensionRedirectUri ? extensionRedirect({ error: "google-failed" }) : fail("google-failed");
  }
  const context = contextFromRequest(request);
  const result = await resolveGoogleAccount({
    email: identity.email,
    emailVerified: identity.emailVerified,
    mode,
    termsAccepted: state.termsAccepted === true,
    workspaceName: state.workspaceName,
    context,
  });
  if (!result.ok) {
    if (state.extensionRedirectUri) {
      const error = result.error === "throttled" ? "throttled" : result.error === "google-no-account" ? "google-no-account" : result.error;
      return extensionRedirect({ error });
    }
    if (result.error === "throttled") return fail("throttled", { retry: Math.ceil(result.retryAfterMs / 1000) });
    // A new Google user who used "Sign in" has not accepted our terms yet:
    // send them to the sign-up form, which collects that before Google.
    if (result.error === "google-no-account") {
      return clearState(NextResponse.redirect(publicUrl(loginUrl({ tab: "signup", error: "google-no-account", next }), request)));
    }
    return fail(result.error);
  }

  if (state.extensionRedirectUri) {
    if (result.mustChangePassword) return extensionRedirect({ error: "password-change-required" });
    try {
      const exchangeCode = await createGoogleExtensionCode({
        userId: result.userId,
        workspaceId: result.workspaceId,
        codeChallenge: state.extensionCodeChallenge!,
      });
      return extensionRedirect({ code: exchangeCode });
    } catch {
      return extensionRedirect({ error: "google-failed" });
    }
  }

  const session = await createSession(result.userId, { ...context, activeWorkspaceId: result.workspaceId });
  const response = NextResponse.redirect(publicUrl(result.mustChangePassword ? "/account?required=1" : next, request));
  response.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    expires: session.expiresAt,
  });
  return clearState(response);
}

export async function GET(request: Request) {
  const store = await cookies();
  const state = openOAuthState(store.get(OAUTH_STATE_COOKIE)?.value ?? "");
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const stateParam = params.get("state");
  const denied = Boolean(params.get("error"));

  if (state && (state.purpose === "signin" || state.purpose === "signup")) {
    return signInWithGoogle(request, state, code, stateParam, denied);
  }
  return connectAccount(request, state, code, stateParam, denied);
}
