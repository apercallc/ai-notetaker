"use client";

import { useActionState } from "react";
import {
  changePasswordAction,
  createApiTokenAction,
  deleteWorkspaceAction,
  disconnectGoogleAction,
  leaveWorkspaceAction,
  revokeApiTokenAction,
  revokeSessionAction,
  signOutEverywhereAction,
  switchWorkspaceAction,
  type ChangePasswordState,
  type CreateApiTokenState,
  type DeleteWorkspaceState,
  type LeaveWorkspaceState,
} from "./actions";

// Server actions return expected failures as values; these thin wrappers
// let forms bind them while keeping the results for inline messages.
async function callChangePassword(previous: ChangePasswordState | null, formData: FormData): Promise<ChangePasswordState> {
  return changePasswordAction(formData);
}
async function callCreateToken(previous: CreateApiTokenState | null, formData: FormData): Promise<CreateApiTokenState> {
  return createApiTokenAction(formData);
}
async function callDeleteWorkspace(previous: DeleteWorkspaceState | null, formData: FormData): Promise<DeleteWorkspaceState> {
  return deleteWorkspaceAction(formData);
}
async function callLeaveWorkspace(previous: LeaveWorkspaceState | null, formData: FormData): Promise<LeaveWorkspaceState> {
  return leaveWorkspaceAction(formData);
}

export function ChangePasswordForm() {
  const [result, formAction, pending] = useActionState<ChangePasswordState | null, FormData>(callChangePassword, null);
  return (
    <div>
      <form action={formAction} className="login-form">
        <label htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password" className="text-input" required autoComplete="current-password" />
        <label htmlFor="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password" className="text-input" required minLength={12} autoComplete="new-password" />
        <label htmlFor="confirmPassword">Repeat new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" className="text-input" required minLength={12} autoComplete="new-password" />
        <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Change password"}
        </button>
      </form>
      {result?.ok === true && (
        <p role="status" className="empty-state">
          Password updated. Other devices were signed out.
        </p>
      )}
      {result?.ok === false && (
        <p role="alert" className="error-text">
          {result.error}
        </p>
      )}
    </div>
  );
}

export interface SessionRow {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
}

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
  return (
    <div>
      <ul className="meeting-list">
        {sessions.map((session) => (
          <li key={session.id} className="meeting-card static-row">
            <div className="title">
              {session.device}
              {session.current ? " (this device)" : ""}
            </div>
            <div className="meta">
              {session.ip ? `${session.ip} · ` : ""}
              last used {session.lastUsedAt ?? "unknown"} · signed in {session.createdAt}
            </div>
            {!session.current && (
              <form action={revokeSessionAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <button type="submit" className="button button-secondary">Sign out this device</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form action={signOutEverywhereAction}>
        <button type="submit" className="button button-secondary">Sign out everywhere</button>
      </form>
    </div>
  );
}

export interface TokenRow {
  id: string;
  label: string | null;
  device: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export function ApiTokenPanel({ tokens }: { tokens: TokenRow[] }) {
  const [result, formAction, pending] = useActionState<CreateApiTokenState | null, FormData>(callCreateToken, null);
  return (
    <div>
      <form action={formAction} className="login-form">
        <label htmlFor="token-label">Label</label>
        <input id="token-label" name="label" type="text" className="text-input" placeholder="Chrome extension" maxLength={80} />
        <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Creating…" : "Create sign-in token"}
        </button>
      </form>
      {result?.ok === true && (
        <p role="status" className="empty-state">
          Copy this token now — it won&apos;t be shown again:{" "}
          <code>{result.token}</code>
        </p>
      )}
      {result?.ok === false && (
        <p role="alert" className="error-text">
          {result.error}
        </p>
      )}
      {tokens.length > 0 && (
        <ul className="meeting-list">
          {tokens.map((token) => (
            <li key={token.id} className="meeting-card static-row">
              <div className="title">{token.label ?? "Sign-in token"}</div>
              <div className="meta">
                {token.device ? `${token.device} · ` : ""}created {token.createdAt} · last used{" "}
                {token.lastUsedAt ?? "never"} · expires {token.expiresAt}
              </div>
              <form action={revokeApiTokenAction}>
                <input type="hidden" name="tokenId" value={token.id} />
                <button type="submit" className="button button-secondary">Revoke</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GoogleConnectionPanel({
  configured,
  connected,
  accountEmail,
}: {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
}) {
  if (!configured) {
    return <p role="status" className="muted-copy">Google Calendar and Drive are not configured on this deployment.</p>;
  }
  if (!connected) {
    return <p><a href="/api/google/oauth/connect" className="button button-primary">Connect Google</a></p>;
  }
  return (
    <div>
      <p role="status" className="muted-copy">Connected{accountEmail ? ` as ${accountEmail}` : ""}. Calendar lookup and Drive exports are available to your signed-in extension.</p>
      <form action={disconnectGoogleAction}>
        <button type="submit" className="button button-secondary">Disconnect Google</button>
      </form>
    </div>
  );
}

export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: {
  workspaces: Array<{ id: string; name: string; role: "owner" | "member" }>;
  activeWorkspaceId: string;
}) {
  if (workspaces.length < 2) return null;
  return (
    <form action={switchWorkspaceAction} className="login-form">
      <label htmlFor="workspace-switch">Workspace</label>
      <select id="workspace-switch" name="workspaceId" defaultValue={activeWorkspaceId} className="text-input">
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name} ({workspace.role})
          </option>
        ))}
      </select>
      <button type="submit" className="button button-secondary">Switch</button>
    </form>
  );
}

export function LeaveWorkspaceForm({ workspaceName }: { workspaceName: string }) {
  const [result, formAction, pending] = useActionState<LeaveWorkspaceState | null, FormData>(callLeaveWorkspace, null);
  return (
    <form action={formAction} className="login-form">
      <label htmlFor="leave-confirm">Type “{workspaceName}” to leave this workspace</label>
      <input id="leave-confirm" name="confirm" type="text" className="text-input" autoComplete="off" required />
      <button type="submit" className="button button-secondary" disabled={pending} aria-busy={pending}>
        {pending ? "Leaving…" : "Leave workspace"}
      </button>
      {result?.ok === false && (
        <p role="alert" className="error-text">
          {result.error}
        </p>
      )}
    </form>
  );
}

export function DeleteWorkspaceForm({ workspaceName }: { workspaceName: string }) {
  const [result, formAction, pending] = useActionState<DeleteWorkspaceState | null, FormData>(callDeleteWorkspace, null);
  return (
    <form action={formAction} className="login-form">
      <label htmlFor="delete-confirm">Type “{workspaceName}” to delete this workspace and all of its meetings</label>
      <input id="delete-confirm" name="confirm" type="text" className="text-input" autoComplete="off" required />
      <button type="submit" className="button button-danger" disabled={pending} aria-busy={pending}>
        {pending ? "Deleting…" : "Delete workspace"}
      </button>
      {result?.ok === false && (
        <p role="alert" className="error-text">
          {result.error}
        </p>
      )}
    </form>
  );
}