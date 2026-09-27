"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  label = "Continue",
  pendingLabel = "Checking…",
  variant = "primary",
}: {
  label?: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`button button-${variant}`} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
