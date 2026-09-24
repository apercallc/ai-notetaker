import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { AddMemberForm } from "./AddMemberForm";
import { RetentionPolicyForm } from "./RetentionPolicyForm";
import { managedHostingEnabled } from "@/lib/managedAuth";

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

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
          </li>
        ))}
      </ul>

      <h2 className="section-title">Add a teammate</h2>
      <p className="muted-copy">
        They&apos;ll sign in with the email and one-time password shown after you add them — share it however
        you already communicate (there&apos;s no email sending built in).
      </p>
      <AddMemberForm />

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
