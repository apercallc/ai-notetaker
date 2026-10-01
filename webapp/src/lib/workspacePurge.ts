import { prisma } from "./db";
import { BillingError, cancelWorkspaceSubscription } from "./billing";
import { deleteObject, queueObjectDeletions } from "./objectStorage";
import { disconnectGoogle } from "./googleIntegration";

export type PurgeWorkspaceResult = { ok: true } | { ok: false; error: string };

/**
 * Permanently deletes a workspace: cancels its Stripe subscription first (and
 * aborts if that fails or a checkout is open), removes every meeting, the
 * workspace row, and any member account left with no workspace, then cleans up
 * private audio objects. Callers must have already authorized the caller as
 * the workspace owner; the id never comes from the client.
 */
export async function purgeWorkspace(workspaceId: string): Promise<PurgeWorkspaceResult> {
  // Stop billing first. If Stripe cannot cancel, keep the workspace so the
  // customer is never left paying for data they can no longer reach.
  try {
    await cancelWorkspaceSubscription(workspaceId);
  } catch (error) {
    console.error("workspace deletion blocked: subscription cancellation failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    const detail = error instanceof BillingError && error.message.startsWith("A checkout is in progress") ? ` ${error.message}` : " Cancel it under Billing, or try again in a moment.";
    return { ok: false, error: `We couldn't cancel this workspace's subscription, so nothing was deleted.${detail}` };
  }

  const memberUserIds = (
    await prisma.workspaceMembership.findMany({
      where: { workspaceId },
      select: { userId: true },
    })
  ).map((membership) => membership.userId);

  // Legacy meetings have no Workspace foreign key. Gather every private
  // object key up front, then delete the rows in ONE transaction so a
  // mid-loop failure cannot leave a half-deleted workspace (some meetings
  // gone, workspace still present, user confused about what happened).
  // Object storage is cleaned up after the commit; a storage failure logs
  // the orphaned keys for operator repair rather than rolling back a
  // deletion the user already confirmed.
  const immediate: string[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
      await tx.managedUpload.updateMany({ where: { workspaceId }, data: { status: "expired" } });
      let after: string | undefined;
      do {
        const meetings = await tx.meeting.findMany({
          where: { workspaceId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100,
          select: { id: true, recordingObjectKey: true, uploads: { select: { objectKey: true, chunks: { select: { objectKey: true, signedUntil: true } }, directTickets: { select: { objectKey: true, signedUntil: true } } } } },
        });
        const objects = meetings.flatMap((meeting) => [
          { objectKey: meeting.recordingObjectKey, signedUntil: null },
          ...meeting.uploads.flatMap((upload) => [{ objectKey: upload.objectKey, signedUntil: null }, ...upload.chunks, ...upload.directTickets]),
        ]).filter((object): object is { objectKey: string; signedUntil: Date | null } => Boolean(object.objectKey));
        await queueObjectDeletions(objects, tx);
        for (const object of objects) {
          if (immediate.length < 100 && (!object.signedUntil || object.signedUntil <= new Date())) immediate.push(object.objectKey);
        }
        after = meetings.length === 100 ? meetings.at(-1)?.id : undefined;
      } while (after);
      // Deletes cascade from the workspace row to membership/subscription/
      // upload/job/share rows, but legacy meetings have no Workspace relation,
      // so they are removed explicitly — inside the same transaction.
      await tx.meeting.deleteMany({ where: { workspaceId } });
      await tx.workspace.delete({ where: { id: workspaceId } });
      // An account whose last workspace is gone can never sign in again and
      // would squat its email address — remove it.
      for (const userId of memberUserIds) {
        await tx.user.deleteMany({ where: { id: userId, memberships: { none: {} } } });
      }
      // A large workspace cascades many rows; the default 5 s interactive limit would time out
      // after billing is already cancelled.
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (error) {
    console.error("workspace deletion failed after cancelling billing", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Billing was cancelled, but we couldn't finish deleting the workspace. Nothing else was removed; try deleting it again in a moment." };
  }

  const cleanup: PromiseSettledResult<void>[] = [];
  for (let offset = 0; offset < immediate.length; offset += 16) {
    cleanup.push(...await Promise.allSettled(immediate.slice(offset, offset + 16).map((key) => deleteObject(key))));
  }
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) {
    console.error("workspace deletion object cleanup failed", {
      workspaceId,
      failedObjects: failures.length,
      firstError: failures[0]?.reason instanceof Error ? failures[0].reason.message : String(failures[0]?.reason),
    });
  }

  return { ok: true };
}

export type DeleteAccountResult = { ok: true } | { ok: false; error: string };

/**
 * Permanently deletes one person's account. Workspaces they own alone are
 * purged; workspaces shared with other people block the deletion (transfer
 * ownership or remove the members first) so nobody else's data is destroyed
 * by accident; memberships elsewhere are simply removed. Google access is
 * revoked and every session and token goes with the user row.
 */
export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId },
    select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
  });
  const toPurge: string[] = [];
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const others = await prisma.workspaceMembership.findMany({ where: { workspaceId: membership.workspaceId, userId: { not: userId } }, select: { role: true } });
    if (others.some((other) => other.role === "owner")) continue; // someone else can keep it running
    if (others.length > 0) {
      return { ok: false, error: `"${membership.workspace.name}" has other members and you are its only owner. Promote another owner or remove the members, then try again.` };
    }
    toPurge.push(membership.workspaceId);
  }

  for (const workspaceId of toPurge) {
    const purged = await purgeWorkspace(workspaceId);
    if (!purged.ok) return purged;
  }
  await disconnectGoogle(userId);
  // Cascades remove remaining memberships, sessions, API tokens and auth tokens.
  await prisma.user.deleteMany({ where: { id: userId } });
  return { ok: true };
}
