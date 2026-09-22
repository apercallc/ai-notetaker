import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedBearer, isAuthorizedSession } from "./lib/auth";

// Proxy files (Next.js 16's replacement for middleware.ts) always run on
// the Node.js runtime, which is exactly why we moved off middleware.ts in
// the first place — lib/auth.ts's constant-time comparison needs
// node:crypto, which the old Edge-runtime middleware didn't support.

/**
 * Every route in this app requires the deploy-time AUTH_TOKEN, including
 * reads — see docs/webapp-api.md and the architecture spec §3.5. This is
 * the single enforcement point for that rule; it must run before every
 * page and API route (see `config.matcher` below), not be re-implemented
 * per-route where it's easy to forget on one.
 *
 * Two auth mechanisms, for two different kinds of client:
 * - `/api/*` (the extension, future mobile clients): a Bearer token in the
 *   Authorization header, per docs/webapp-api.md. `/api/health` is the one
 *   deliberate exception, documented there.
 * - Everything else (the browser UI): a session cookie set once after
 *   entering the token on /login, so the user isn't retyping it on every
 *   page load. This is a pragmatic addition on top of the documented API
 *   contract, not a deviation from it — docs/webapp-api.md only specifies
 *   the /api/* surface.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const authorized = isAuthorizedBearer(request.headers.get("authorization"));
    if (!authorized) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname === "/login") {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get("session")?.value;
  if (!isAuthorizedSession(sessionCookie)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own internals and static assets — those don't
  // need to pass through the auth check. In particular, excluding SVG and
  // font files keeps the login page's own assets usable before a session
  // exists.
  matcher: [
    "/((?!_next/static|_next/image|_next/font|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)",
  ],
};
