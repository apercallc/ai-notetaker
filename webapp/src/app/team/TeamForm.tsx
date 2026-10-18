"use client";

import { useActionState, type ReactNode } from "react";
import { manageTeam, type TeamActionResult } from "./actions";

/** `confirmMessage` asks once before an action that can't be undone from this page (removing someone). */
export function TeamForm({ operation, id, confirmMessage, children }: { operation: string; id?: string; confirmMessage?: string; children: ReactNode }) {
  const [result, action, pending] = useActionState<TeamActionResult | null, FormData>((_, form) => manageTeam(form), null);
  return <form action={action} className="login-form" onSubmit={confirmMessage ? (event) => { if (!window.confirm(confirmMessage)) event.preventDefault(); } : undefined}>
    <input type="hidden" name="operation" value={operation} />
    <input type="hidden" name="id" value={id ?? ""} />
    <fieldset disabled={pending}>{children}</fieldset>
    {pending && <p role="status">Saving…</p>}
    {result && <p role={result.ok ? "status" : "alert"}>{result.ok ? result.message : result.error}</p>}
    {result?.ok && result.link && <input aria-label="Private link" className="text-input" readOnly value={result.link} onFocus={event => event.target.select()} />}
  </form>;
}
