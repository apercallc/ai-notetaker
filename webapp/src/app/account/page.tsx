import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { prisma } from "@/lib/db";
import { describeUserAgent, listUserSessions } from "@/lib/sessions";
import { listApiTokens } from "@/lib/apiTokens";
import { listUserWorkspaces } from "@/lib/workspaces";
import { ApiTokenPanel, ChangePasswordForm, DeleteAccountForm, DeleteWorkspaceForm, GoogleConnectionPanel, LeaveWorkspaceForm, SessionList, WorkspaceSwitcher } from "./AccountForms";
import { googleConnectionStatus } from "@/lib/googleIntegration";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwordPolicy";
import { ACCOUNT_TABS, resolveAccountTab } from "./tabs";

export const metadata = { title: "Settings", referrer: "no-referrer", robots: { index: false, follow: false } };

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
  searchParams: Promise<{ tab?: string; required?: string; google?: string; googleError?: string }>;
}) {
  const session = await requireSession({ allowPasswordChange: true });
  const [workspaces, sessions, tokens, workspace, google] = await Promise.all([
    listUserWorkspaces(session.userId),
    listUserSessions(session.userId),
    listApiTokens(session.userId),
    prisma.workspace.findUniqueOrThrow({
      where: { id: session.workspaceId },
      select: { name: true, retentionDays: true },
    }),
    googleConnectionStatus(session.userId),
  ]);
  const params = await searchParams;
  const { required, google: googleNotice, googleError } = params;
  const tab = resolveAccountTab(params);

  return (
    <div className="container">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="total-count">{session.email}</p>
      </div>

      {required === "1" && (
        <p role="alert" className="error-text">
          Your password was set by a workspace owner. Choose a new one before continuing.
        </p>
      )}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {ACCOUNT_TABS.map((item) => (
              <li key={item.id}>
                <Link href={`/account?tab=${item.id}`} aria-current={item.id === tab ? "page" : undefined}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="settings-panel">
          {tab === "security" && (
            <>
              <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={session.workspaceId} />

              <section className="settings-card">
                <h2>Password</h2>
                <p className="muted-copy">At least {MIN_PASSWORD_LENGTH} characters. Changing it signs out your other devices.</p>
                <ChangePasswordForm />
              </section>

              <section className="settings-card">
                <h2>Signed-in devices</h2>
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
              </section>
            </>
          )}

          {tab === "integrations" && (
            <>
              <section className="settings-card">
                <h2>Extension &amp; API tokens</h2>
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
              </section>

              <section id="google-services" className="settings-card">
                <h2>Google Drive</h2>
                <p className="muted-copy">Connect a Google account to export completed notes to a Google Doc in your own Drive. AI Notetaker can only access files it creates. Google access is stored encrypted and can be removed here.</p>
                {googleNotice === "connected" && <p role="status" className="empty-state">Google account connected.</p>}
                {googleError && <p role="alert" className="error-text">{googleError}</p>}
                <GoogleConnectionPanel {...google} />
              </section>
            </>
          )}

          {tab === "data" && (
            <>
              <section className="settings-card">
                <h2>Export</h2>
                <p className="muted-copy">Download every meeting in {workspace.name} — summary, transcript, and action items — as one JSON file.</p>
                <a href="/account/export" className="button button-secondary" download>
                  Export all meetings
                </a>
              </section>

              <section className="settings-card">
                <h2>Privacy</h2>
                <ul className="muted-copy settings-list">
                  <li>Workspace members can see your notes. Shared links work until you revoke them or they expire.</li>
                  <li>Hosted AI uses your audio only to transcribe it. It is deleted once processing finishes, or after 24 hours if processing fails. Audio never appears in your library.</li>
                  <li>
                    Notes and transcripts are{" "}
                    {workspace.retentionDays === null
                      ? "kept until you delete them or the workspace."
                      : `kept for ${workspace.retentionDays} day${workspace.retentionDays === 1 ? "" : "s"} under your retention policy.`}
                  </li>
                  <li>Deleting a meeting or the workspace removes it permanently.</li>
                </ul>
              </section>
            </>
          )}

          {tab === "danger" && (
            <>
              <section className="settings-card settings-card--danger">
                <h2>{session.role === "owner" ? "Delete workspace" : "Leave workspace"}</h2>
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
              </section>

              <section className="settings-card settings-card--danger">
                <h2>Delete my account</h2>
                <p className="muted-copy">
                  Permanently deletes your account, your Google connection, and every workspace you own alone (with its meetings
                  and any active subscription). Workspaces shared with others are left in place and you are simply removed.
                  Export your meetings first — this cannot be undone.
                </p>
                <DeleteAccountForm email={session.email} />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
