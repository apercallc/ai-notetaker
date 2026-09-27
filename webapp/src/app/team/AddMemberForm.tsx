"use client";

import { useActionState } from "react";
import { addMember, type AddMemberResult } from "./actions";

async function submit(_previous: AddMemberResult | null, formData: FormData): Promise<AddMemberResult> {
  // addMember returns its expected failures rather than throwing them (see
  // its doc comment) — a throw here would be a genuine bug, and Next's own
  // error boundary is the right place for it.
  return addMember(formData);
}

export function AddMemberForm() {
  const [result, formAction, pending] = useActionState<AddMemberResult | null, FormData>(submit, null);

  return (
    <div>
      <form action={formAction} className="login-form">
        <label htmlFor="new-member-email">Email</label>
        <input id="new-member-email" name="email" type="email" className="text-input" required autoComplete="off" />
        <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Adding…" : "Add member"}
        </button>
      </form>
      {result?.ok === true && (
        <p role="status" className="empty-state">
          Added {result.email}. One-time password (copy this now — it won&apos;t be shown again):{" "}
          <code>{result.temporaryPassword}</code>
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
