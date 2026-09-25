import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { describeUserAgent, listUserSessions } from "@/lib/sessions";
import { listApiTokens } from "@/lib/apiTokens";
import { listUserWorkspaces } from "@/lib/workspaces";
import { ApiTokenPanel, ChangePasswordForm, DeleteWorkspaceForm, LeaveWorkspaceForm, SessionList, WorkspaceSwitcher } from "./AccountForms";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwordPolicy";

export const metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

function formatDate(value: Date | null): string {
  if (!value) return "";
  return value.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(value: Date | null): string {
  if (!value) return "never";
  return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const session = await requireSession({ allowPasswordChange: true });
  const [workspaces, sessions, tokens, workspace] = await Promise.all([
    listUserWorkspaces(session.userId),
    listUserSessions(session.userId),
    listApiTokens(session.userId),
    prisma.workspace.findUniqueOrThrow({
      where: { id: session.workspaceId },
      select: { name: true, retentionDays: true },
    }),
  ]);
  const { required } = await searchParams;

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">
        ← Meetings
      </Link>
      <div className="page-header">
        <h1>Account</h1>
      </div>
      <p className="muted-copy">{session.email}</p>

      {required === "1" && (
        <p role="alert" className="error-text">
          Your password was set by a workspace owner. Choose a new one before continuing.
        </p>
      )}

      <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={session.workspaceId} />

      <h2 className="section-title">Password</h2>
      <p className="muted-copy">At least {MIN_PASSWORD_LENGTH} characters. Changing it signs out your other devices.</p>
      <ChangePasswordForm />

      <h2 className="section-title">Signed-in devices</h2>
      <p className="muted-copy">Each device keeps its own session. Revoke anything you don&apos;t recognize.</p>
      <SessionList
        sessions={sessions.map((row) => ({
          id: row.id,
          device: describeUserAgent(row.userAgent),
          ip: row.ip,
          createdAt: formatDate(row.createdAt),
          lastUsedAt: row.lastUsedAt ? formatDateTime(row.lastUsedAt) : null,
          current: row.id === session.sessionId,
        }))}
      />

      <h2 className="section-title">Extension &amp; API tokens</h2>
      <p className="muted-copy">
        Tokens sign the browser extension in without a password. They expire after 90 days of not being used
        and can be revoked here at any time.
      </p>
      <ApiTokenPanel
        tokens={tokens.map((token) => ({
          id: token.id,
          label: token.label,
          device: token.userAgent ? describeUserAgent(token.userAgent) : null,
          createdAt: formatDate(token.createdAt),
          lastUsedAt: token.lastUsedAt ? formatDateTime(token.lastUsedAt) : null,
          expiresAt: formatDate(token.expiresAt),
        }))}
      />

      <h2 className="section-title">Export</h2>
      <p className="muted-copy">Download every meeting in {workspace.name} — summary, transcript, and action items — as one JSON file.</p>
      <p>
        <a href="/account/export" className="button button-secondary" download>
          Export all meetings
        </a>
      </p>

      <h2 className="section-title">Privacy</h2>
      <p className="muted-copy">
        Workspace members can access your notes; shared links grant access until revoked or expired. Audio recordings are kept while the meeting
        history is{" "}
        {workspace.retentionDays === null
          ? "retained indefinitely; export or delete below to control that yourself."
          : `limited to ${workspace.retentionDays} day${workspace.retentionDays === 1 ? "" : "s"} by your retention policy.`}{" "}
        Deleting a meeting or the workspace removes it permanently.
      </p>

      <h2 className="section-title">Leave or delete</h2>
      {session.role === "owner" ? (
        <>
          <p className="muted-copy">
            Deleting the workspace removes every meeting and member account that belongs to nothing else. This
            cannot be undone.
          </p>
          <DeleteWorkspaceForm workspaceName={workspace.name} />
        </>
      ) : (
        <>
          <p className="muted-copy">
            Leaving removes your access; your account is deleted if you belong to no other workspace.
          </p>
          <LeaveWorkspaceForm workspaceName={workspace.name} />
        </>
      )}
    </div>
  );
}
