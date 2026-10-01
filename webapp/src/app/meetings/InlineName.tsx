"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A text field for renaming in place. Enter or leaving the field saves,
 * Escape cancels, and an unchanged or empty name just closes. A refused name
 * (duplicate, too long) stays open with the reason underneath.
 */
export function InlineName({
  value,
  label,
  maxLength,
  placeholder,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  maxLength: number;
  placeholder?: string;
  /** Resolve with an error message to keep the field open, or null when saved. */
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const done = useRef(false);
  const field = useRef<HTMLInputElement>(null);

  // A refused name keeps the field open: put the cursor back in it so keyboard and screen-reader users land on the problem.
  useEffect(() => {
    if (error) field.current?.focus();
  }, [error]);

  async function commit(raw: string) {
    if (done.current || saving) return;
    const next = raw.trim();
    if (next === "" || next === value) {
      done.current = true;
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    const problem = await onSave(next);
    setSaving(false);
    if (problem) setError(problem);
    else done.current = true;
  }

  return (
    <span className="inline-name">
      <input
        ref={field}
        className="text-input inline-name-input"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        defaultValue={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus
        readOnly={saving}
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); void commit(event.currentTarget.value); }
          if (event.key === "Escape") { event.preventDefault(); done.current = true; onCancel(); }
        }}
        onBlur={(event) => void commit(event.currentTarget.value)}
      />
      {error && <span className="error-text inline-name-error" role="alert">{error}</span>}
    </span>
  );
}
