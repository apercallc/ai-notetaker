import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionContext } from "./sessions";
import { resolveActiveWorkspace } from "./workspaces";

/**
 * Server-only helper every browser page/action calls to resolve the
 * current logged-in user. Real per-user auth (see
 * docs/superpowers/specs/2026-09-22-webapp-multi-user-auth-design.md) —
 * separate from lib/auth.ts's isAuthorizedBearer, which still gates the
 * /api/* ingestion contract. Redirects to /login if there's no valid
 * session, matching how src/proxy.ts already redirects unauthenticated
 * browser requests.
 *
 * Deliberately its own module, not part of lib/auth.ts: this file's
 * next/headers import is only valid in Server Components/Route Handlers,
 * not in Middleware (src/proxy.ts) or anything reachable from a Client
 * Component. lib/auth.ts is imported from both of those (via
 * lib/meetings.ts's LOCAL_USER_ID), so pulling next/headers into it broke
 * the production build.
 */
export interface RequireSessionOptions {
  /** Only /account sets this, so a forced password change can happen at all. */
  allowPasswordChange?: boolean;
}

export async function requireSession(
  options: RequireSessionOptions = {},
): Promise<{ userId: string; workspaceId: string; role: "owner" | "member"; email: string; sessionId: string }> {
  const store = await cookies();
  const context = await getSessionContext(store.get("session")?.value);
  if (!context) redirect("/login");

  // An owner-issued temporary password must be replaced before anything else
  // in the app is reachable.
  if (context.user.mustChangePassword && !options.allowPasswordChange) redirect("/account?required=1");

  // Workspace switcher: honour the session's chosen workspace only while the
  // user is still a member; otherwise the deterministic default.
  const active = await resolveActiveWorkspace(context.user.id, context.activeWorkspaceId);
  if (!active) redirect("/login");

  return {
    userId: context.user.id,
    workspaceId: active.workspaceId,
    role: active.role,
    email: context.user.email,
    sessionId: context.sessionId,
  };
}
