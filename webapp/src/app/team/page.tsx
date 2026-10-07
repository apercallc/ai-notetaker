import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { TeamForm } from "./TeamForm";
import { listPendingInvites } from "@/lib/authTokens";
import { RetentionPolicyForm } from "./RetentionPolicyForm";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { TEAM_PLAN_REQUIRED_MESSAGE, teamPlanActive } from "@/lib/teamAccess";

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

  const [teamPlan, members, workspace, invites] = await Promise.all([
    teamPlanActive(session.workspaceId),
    prisma.workspaceMembership.findMany({
      where: { workspaceId: session.workspaceId },
      include: { user: { select: { email: true, createdAt: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId }, select: { retentionDays: true } }),
    listPendingInvites(session.workspaceId),
  ]);

  return (
    <div className="container">
      <div className="page-header">
        <h1>Team</h1>
        <p className="total-count">{members.length} {members.length === 1 ? "member" : "members"}</p>
      </div>

      <section className="settings-card team-invite" aria-labelledby="invite-title">
        <h2 id="invite-title">Invite a teammate</h2>
        {teamPlan ? <p className="muted-copy">They can create an account or join with their existing one.</p> : <p className="muted-copy">{TEAM_PLAN_REQUIRED_MESSAGE} <Link href="/billing">See plans</Link>.</p>}
        {teamPlan && <TeamForm operation="invite"><label>Email <input name="email" type="email" className="text-input" required autoComplete="off" /></label><button className="button button-primary" type="submit">Send invite</button></TeamForm>}
      </section>

      <h2 className="section-title">Members</h2>
      <ul className="team-members">
        {members.map((membership) => (
          <li key={membership.id}>
            <details className="team-member">
              <summary>
                <span className="team-member-email">{membership.user.email}</span>
                <span className={`role-badge${membership.role === "owner" ? " role-badge--owner" : ""}`}>{membership.role}</span>
                <span className="team-member-joined">Joined {formatDate(membership.createdAt)}</span>
              </summary>
              <div className="team-member-actions">
                <TeamForm operation="role" id={membership.id}>
                  <label>Role <select name="role" defaultValue={membership.role}><option value="member">Member</option><option value="owner">Owner</option></select></label>
                  <button className="button" type="submit">Update role</button>
                </TeamForm>
                <TeamForm operation="reset" id={membership.id}><button className="button" type="submit">Send password reset</button></TeamForm>
                <TeamForm operation="remove" id={membership.id}><button className="button button-danger" type="submit">Remove member</button></TeamForm>
              </div>
            </details>
          </li>
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h2 className="section-title">Pending invitations</h2>
          <ul className="team-members">
            {invites.map((invite) => (
              <li key={invite.id} className="team-member">
                <div className="team-member-actions">
                  <span className="team-member-email">{invite.email}</span>
                  <span className="team-member-joined">Expires {formatDate(invite.expiresAt)}</span>
                  <TeamForm operation="revoke-invite" id={invite.id}><button className="button" type="submit">Revoke invitation</button></TeamForm>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="settings-card">
        <h2>Activity log</h2>
        <p className="muted-copy">See who added members, changed settings, shared or deleted notes, and connected integrations.</p>
        <Link className="button button-secondary button-small" href="/team/audit">Open activity log</Link>
      </section>

      {managedHostingEnabled() && teamPlan && (
        <section className="settings-card">
          <h2>Retention</h2>
          <p className="muted-copy">
            Set how long synced notes and transcripts remain in this workspace.
          </p>
          <RetentionPolicyForm retentionDays={workspace.retentionDays} />
        </section>
      )}
    </div>
  );
}
