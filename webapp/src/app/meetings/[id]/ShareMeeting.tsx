"use client";

import { useActionState } from "react";
import { createMeetingShareAction, type ShareActionResult } from "./actions";

async function submit(_previous: ShareActionResult | null, formData: FormData): Promise<ShareActionResult> {
  return createMeetingShareAction(formData);
}

export function ShareMeeting({ meetingId }: { meetingId: string }) {
  const [result, formAction, pending] = useActionState<ShareActionResult | null, FormData>(submit, null);
  const shareUrl = result?.ok ? `${window.location.origin}/share/${encodeURIComponent(result.token)}` : "";

  return (
    <div className="share-panel">
      <form action={formAction} className="share-form">
        <input type="hidden" name="meetingId" value={meetingId} />
        <label htmlFor="share-expiry">Share link expires in</label>
        <select id="share-expiry" name="expiresInDays" defaultValue="7">
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </select>
        <button type="submit" className="button button-secondary" disabled={pending} aria-busy={pending}>
          {pending ? "Creating…" : "Create private share link"}
        </button>
      </form>
      {result?.ok && (
        <p className="share-result" role="status">
          <a href={shareUrl} target="_blank" rel="noreferrer">Open share link</a>
          <input aria-label="Share link" readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} />
          <span>Expires {new Date(result.expiresAt).toLocaleDateString()}</span>
        </p>
      )}
      {result && !result.ok && <p className="error-text" role="alert">{result.error}</p>}
    </div>
  );
}
