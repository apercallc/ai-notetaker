"use client";

import { useState, useTransition } from "react";
import { CopyButton } from "@/components/CopyButton";
import { LocalTime } from "@/components/LocalTime";
import type { ActiveShare } from "@/lib/sharing";
import { createMeetingShareAction, revokeMeetingShareAction } from "./actions";

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

/**
 * Create, copy and revoke private links. A link's token is stored only as a
 * hash, so its URL is shown once, when it is created. Until the page is
 * reloaded, that link keeps a Copy button; afterwards it can only be
 * revoked — the owner makes a new one if they need the URL again.
 */
export function ShareMeeting({ meetingId, links }: { meetingId: string; links: ActiveShare[] }) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [, startRevoke] = useTransition();

  function create(formData: FormData) {
    setError(null);
    startCreate(async () => {
      const result = await createMeetingShareAction(formData);
      if (result.ok) {
        setTokens((current) => ({ ...current, [result.id]: result.token }));
        setJustCreated(result.id);
      } else {
        setError(result.error);
      }
    });
  }

  function revoke(shareId: string) {
    setError(null);
    setRevokingId(shareId);
    const formData = new FormData();
    formData.set("shareId", shareId);
    formData.set("meetingId", meetingId);
    startRevoke(async () => {
      try {
        const revoked = await revokeMeetingShareAction(formData);
        if (!revoked) setError("That link was already revoked or has expired.");
      } catch {
        setError("Couldn't revoke that link. Try again.");
      } finally {
        setRevokingId(null);
        setJustCreated((current) => (current === shareId ? null : current));
      }
    });
  }

  const createdToken = justCreated ? tokens[justCreated] : undefined;

  return (
    <div className="share-panel">
      <form action={create} className="share-form">
        <input type="hidden" name="meetingId" value={meetingId} />
        <label htmlFor="share-expiry">Expires in</label>
        <select id="share-expiry" name="expiresInDays" defaultValue="7" className="select">
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </select>
        <button type="submit" className="button button-secondary" disabled={creating} aria-busy={creating}>
          {creating ? "Creating…" : "Create link"}
        </button>
      </form>

      {createdToken && (
        <div className="share-result" role="status">
          <p className="muted-copy">Copy this link now — for your security it won&apos;t be shown again.</p>
          <div className="share-result-row">
            <input aria-label="New share link" readOnly value={shareUrl(createdToken)} onFocus={(event) => event.currentTarget.select()} className="text-input" />
            <CopyButton text={shareUrl(createdToken)} label="Copy link" className="button button-primary" />
          </div>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      <h3 className="subsection-title">Active links</h3>
      {links.length === 0 ? (
        <p className="muted-copy">No active links. Only you and your workspace can see this meeting.</p>
      ) : (
        <ul className="share-links">
          {links.map((link) => (
            <li key={link.id} className="share-link-row">
              <span className="share-link-meta">
                Created <LocalTime iso={link.createdAt} style="date" /> · expires <LocalTime iso={link.expiresAt} style="date" />
              </span>
              <span className="share-link-actions">
                {tokens[link.id] ? (
                  <CopyButton text={shareUrl(tokens[link.id]!)} label="Copy" className="button button-secondary button-small" />
                ) : (
                  <span className="muted-copy">URL shown once</span>
                )}
                <button
                  type="button"
                  className="button button-danger button-small"
                  onClick={() => revoke(link.id)}
                  disabled={revokingId === link.id}
                  aria-busy={revokingId === link.id}
                >
                  {revokingId === link.id ? "Revoking…" : "Revoke"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
