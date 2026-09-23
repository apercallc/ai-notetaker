import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "./sessions";
import { getUserDefaultWorkspaceId, getUserRole } from "./workspaces";

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
export async function requireSession(): Promise<{ userId: string; workspaceId: string; role: "owner" | "member" }> {
  const store = await cookies();
  const sessionId = store.get("session")?.value;
  const user = await getSessionUser(sessionId);
  if (!user) redirect("/login");

  const workspaceId = await getUserDefaultWorkspaceId(user.id);
  if (!workspaceId) redirect("/login");

  const role = await getUserRole(user.id, workspaceId);
  if (!role) redirect("/login");

  return { userId: user.id, workspaceId, role };
}
