import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/sessions";
import { publicUrl } from "@/lib/publicUrl";
import { createOAuthState, GoogleIntegrationError, sealOAuthState } from "@/lib/googleIntegration";

import { contextFromRequest } from "@/lib/requestContext";
import { shouldUseSecureCookies } from "@/lib/sessionCookie";
import { OAUTH_STATE_COOKIE } from "../stateCookie";

export async function GET(request: Request) {
  const store = await cookies();
  const session = await getSessionContext(store.get("session")?.value);
  if (!session) return NextResponse.redirect(publicUrl("/login?next=/account", request));
  if (session.user.mustChangePassword) return NextResponse.redirect(publicUrl("/account?required=1", request));
  try {
    const { state, authorizationUrl } = createOAuthState(session.user.id);
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OAUTH_STATE_COOKIE, sealOAuthState(state), {
      httpOnly: true,
      secure: shouldUseSecureCookies(contextFromRequest(request)),
      sameSite: "lax",
      path: "/api/google/oauth",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    const message = error instanceof GoogleIntegrationError ? error.publicMessage : "Google integration is unavailable. Try again later.";
    return NextResponse.redirect(publicUrl(`/account?googleError=${encodeURIComponent(message)}`, request));
  }
}
