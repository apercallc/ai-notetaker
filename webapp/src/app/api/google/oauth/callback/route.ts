import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/sessions";
import { completeOAuthConnection, GoogleIntegrationError, oauthStateMatches, openOAuthState } from "@/lib/googleIntegration";

const OAUTH_STATE_COOKIE = "google_oauth_state";

function accountRedirect(request: Request, message?: string): NextResponse {
  const url = new URL("/account", request.url);
  if (message) url.searchParams.set("googleError", message);
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, path: "/api/google/oauth", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const store = await cookies();
  const session = await getSessionContext(store.get("session")?.value);
  const state = openOAuthState(store.get(OAUTH_STATE_COOKIE)?.value ?? "");
  const params = new URL(request.url).searchParams;
  if (!session || session.user.mustChangePassword || !state || state.userId !== session.user.id || !oauthStateMatches(state.state, params.get("state"))) {
    return accountRedirect(request, "Google authorization could not be verified. Try connecting again.");
  }
  if (params.get("error")) return accountRedirect(request, "Google authorization was cancelled or denied.");
  const code = params.get("code");
  if (!code) return accountRedirect(request, "Google did not return an authorization code. Try connecting again.");
  try {
    await completeOAuthConnection(session.user.id, code, state);
    const response = NextResponse.redirect(new URL("/account?google=connected", request.url));
    response.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, path: "/api/google/oauth", maxAge: 0 });
    return response;
  } catch (error) {
    return accountRedirect(request, error instanceof GoogleIntegrationError ? error.publicMessage : "Google connection could not be saved. Try again.");
  }
}
