import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { TeamForm } from "./TeamForm";
import { listPendingInvites } from "@/lib/authTokens";
import { RetentionPolicyForm } from "./RetentionPolicyForm";
import { managedHostingEnabled } from "@/lib/managedAuth";

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const session = await requireSession();

  if (session.role !== "owner") {
    return (
      <div className="container">
        <Link href="/meetings" className="back-link">
          ← Meetings
        </Link>
        <p className="empty-state">Only the workspace owner can manage team members.</p>
      </div>
    );
  }

  const members = await prisma.workspaceMembership.findMany({
    where: { workspaceId: session.workspaceId },
    include: { user: { select: { email: true, createdAt: true } } },
    orderBy: { createdAt: "asc" },
  });
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId }, select: { retentionDays: true } });
  const invites = await listPendingInvites(session.workspaceId);

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">
        ← Meetings
      </Link>
      <div className="page-header">
        <h1>Team</h1>
      </div>

      <ul className="meeting-list">
        {members.map((membership) => (
          <li key={membership.id} className="meeting-card static-row">
            <div className="title">{membership.user.email}</div>
            <div className="meta">
              {membership.role} · joined {formatDate(membership.createdAt)}
            </div>
            <TeamForm operation="role" id={membership.id}>
              <label>Role <select name="role" defaultValue={membership.role}><option value="member">Member</option><option value="owner">Owner</option></select></label>
              <button className="button" type="submit">Update role</button>
            </TeamForm>
            <TeamForm operation="reset" id={membership.id}><button className="button" type="submit">Send password reset</button></TeamForm>
            <TeamForm operation="remove" id={membership.id}><button className="button button-danger" type="submit">Remove member</button></TeamForm>
          </li>
        ))}
      </ul>

      <h2 className="section-title">Add a teammate</h2>
      <p className="muted-copy">
        Invite a teammate by email. They can create an account or join with their existing account.
      </p>
      <TeamForm operation="invite"><label>Email <input name="email" type="email" className="text-input" required /></label><button className="button button-primary" type="submit">Invite teammate</button></TeamForm>
      {invites.length > 0 && <><h2>Pending invitations</h2><ul>{invites.map(invite => <li key={invite.id}>{invite.email} · expires {formatDate(invite.expiresAt)}<TeamForm operation="revoke-invite" id={invite.id}><button className="button" type="submit">Revoke invitation</button></TeamForm></li>)}</ul></>}

      {managedHostingEnabled() ? (
        <>
          <h2 className="section-title">Hosted retention</h2>
          <p className="muted-copy">
            Set how long managed meeting history should remain on the hosted service. The worker applies this policy asynchronously.
          </p>
          <RetentionPolicyForm retentionDays={workspace.retentionDays} />
        </>
      ) : (
        <p className="muted-copy">Hosted retention controls are available only on the project-operated managed service.</p>
      )}
    </div>
  );
}
