import { resolveApiToken, DESKTOP_NOTES_SCOPE } from "./apiTokens";
import { prisma } from "./db";
import { SYNC_SUBSCRIPTION_REQUIRED_MESSAGE, hasSyncAccess } from "./syncAccess";
import { getUserRole } from "./workspaces";

export type DesktopSyncAuth = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
};

export type DesktopSyncAuthResult =
  | { ok: true; auth: DesktopSyncAuth }
  | { ok: false; status: 401 | 402 | 403; message: string };

/** Resolves a revocable notes-only token and rechecks its bound workspace membership on every call. */
export async function authenticateDesktopSync(request: Request, options: { write?: boolean } = {}): Promise<DesktopSyncAuthResult> {
  const authorization = request.headers.get("authorization") ?? "";
  const secret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const token = secret ? await resolveApiToken(secret, Date.now(), DESKTOP_NOTES_SCOPE) : null;
  if (!token?.workspaceId) {
    return { ok: false, status: 401, message: "A valid desktop notes-sync token is required." };
  }

  const requestedWorkspaceId = request.headers.get("x-workspace-id")?.trim();
  if (requestedWorkspaceId && requestedWorkspaceId !== token.workspaceId) {
    return { ok: false, status: 403, message: "This token is limited to another workspace." };
  }
  if (!(await getUserRole(token.id, token.workspaceId))) {
    return { ok: false, status: 403, message: "This token no longer has access to its workspace." };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: token.workspaceId },
    select: { name: true },
  });
  if (!workspace) return { ok: false, status: 403, message: "This token's workspace is unavailable." };
  // Uploading is the paid feature on the managed service. Reading is never gated: someone whose
  // plan ended can still download every note in their workspace to this device. A deployment
  // without managed hosting has no billing, so local development keeps working.
  if (options.write && process.env.MANAGED_HOSTING === "true") {
    const subscription = await prisma.workspaceSubscription.findUnique({
      where: { workspaceId: token.workspaceId },
      select: { plan: true, status: true, graceEndsAt: true },
    });
    if (!hasSyncAccess(subscription)) return { ok: false, status: 402, message: SYNC_SUBSCRIPTION_REQUIRED_MESSAGE };
  }
  return {
    ok: true,
    auth: { userId: token.id, workspaceId: token.workspaceId, workspaceName: workspace.name },
  };
}
