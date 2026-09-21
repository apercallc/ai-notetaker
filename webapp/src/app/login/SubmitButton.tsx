"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
      {pending ? "Checking…" : "Continue"}
    </button>
  );
}
