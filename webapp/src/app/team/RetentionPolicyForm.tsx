"use client";

import { useActionState } from "react";
import { updateRetentionPolicy, type RetentionPolicyResult } from "./actions";

async function submit(_previous: RetentionPolicyResult | null, formData: FormData): Promise<RetentionPolicyResult> {
  return updateRetentionPolicy(formData);
}

export function RetentionPolicyForm({ retentionDays }: { retentionDays: number | null }) {
  const [result, formAction, pending] = useActionState<RetentionPolicyResult | null, FormData>(submit, null);
  const selected = result?.ok ? result.retentionDays : retentionDays;
  return (
    <div>
      <form action={formAction} className="login-form">
        <label htmlFor="retention-days">Delete hosted meetings after</label>
        <select id="retention-days" name="retentionDays" className="text-input" defaultValue={selected === null ? "never" : String(selected)}>
          <option value="never">Never automatically</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">365 days</option>
        </select>
        <p className="muted-copy">Hosted audio, transcripts, summaries, and private shares are removed together. This applies to managed workspaces only.</p>
        <button type="submit" className="button button-secondary" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Save retention policy"}
        </button>
      </form>
      {result?.ok === true && <p role="status" className="empty-state">Retention policy saved.</p>}
      {result?.ok === false && <p role="alert" className="error-text">{result.error}</p>}
    </div>
  );
}
