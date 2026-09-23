"use client";

import { useActionState } from "react";
import { addMember } from "./actions";

type ActionResult = { email: string; temporaryPassword: string } | { error: string } | null;

async function submit(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    return await addMember(formData);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not add member." };
  }
}

export function AddMemberForm() {
  const [result, formAction, pending] = useActionState<ActionResult, FormData>(submit, null);

  return (
    <div>
      <form action={formAction} className="login-form">
        <label htmlFor="new-member-email">Email</label>
        <input id="new-member-email" name="email" type="email" className="text-input" required autoComplete="off" />
        <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Adding…" : "Add member"}
        </button>
      </form>
      {result && "temporaryPassword" in result && (
        <p role="status" className="empty-state">
          Added {result.email}. One-time password (copy this now — it won&apos;t be shown again):{" "}
          <code>{result.temporaryPassword}</code>
        </p>
      )}
      {result && "error" in result && (
        <p role="alert" className="error-text">
          {result.error}
        </p>
      )}
    </div>
  );
}
