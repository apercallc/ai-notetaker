"use client";

import { useActionState, type ReactNode } from "react";
import type { BillingActionState } from "./actions";

interface Props {
  action: (previous: BillingActionState, formData: FormData) => Promise<BillingActionState>;
  label: string;
  pendingLabel?: string;
  secondary?: boolean;
  disabled?: boolean;
  fields?: Record<string, string>;
  children?: ReactNode;
}

/** A billing form button that shows the server action's error message inline instead of throwing. */
export function BillingActionForm({ action, label, pendingLabel = "Redirecting…", secondary = false, disabled = false, fields = {}, children }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as BillingActionState);
  return (
    <form action={formAction}>
      {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
      <button type="submit" className={secondary ? "secondary-button" : undefined} disabled={disabled || pending} aria-busy={pending}>
        {pending ? pendingLabel : label}
      </button>
      {state.error && <p className="error-text" role="alert">{state.error}</p>}
    </form>
  );
}
