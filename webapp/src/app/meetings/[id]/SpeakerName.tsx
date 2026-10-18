"use client";

import { Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { renameSpeakerAction } from "./actions";
import { MAX_SPEAKER_NAME } from "@/lib/speakers.shared";

/**
 * A speaker label that can be renamed in place. The new name appears in the
 * transcript, the summary, action items, exports and shared links.
 */
export function SpeakerName({ meetingId, speakerKey, label, renamed, isYou }: { meetingId: string; speakerKey: string; label: string; renamed: boolean; isYou: boolean }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The same speaker appears on many transcript turns, so ids must be per instance.
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  // Set when the editor closes, so focus goes back to the name the user was on
  // instead of falling to <body>.
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setEditing(false);
  }

  function save(name: string) {
    const formData = new FormData();
    formData.set("meetingId", meetingId);
    formData.set("speakerKey", speakerKey);
    formData.set("name", name);
    setError(null);
    startTransition(async () => {
      let result;
      try {
        result = await renameSpeakerAction(formData);
      } catch {
        result = { status: "error" as const, message: "Something went wrong. Try again." };
      }
      if (result.status === "saved") close();
      else setError(result.message);
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(String(new FormData(event.currentTarget).get("name") ?? ""));
  }

  if (!editing) {
    return (
      <button
        ref={trigger}
        type="button"
        className={`speaker speaker-button${isYou ? " is-you" : ""}`}
        onClick={() => { setEditing(true); setError(null); }}
        aria-label={`Rename ${label}`}
      >
        {label}
        <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    );
  }

  return (
    <form className="speaker-edit" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={fieldId}>Name for {label}</label>
      <input
        ref={input}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        name="name"
        className="text-input"
        defaultValue={renamed ? label : ""}
        placeholder={renamed ? undefined : label}
        maxLength={MAX_SPEAKER_NAME}
        autoFocus
        disabled={pending}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}
      />
      <button type="submit" className="button button-primary button-small" disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</button>
      {renamed && (
        <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => save("")}>Reset</button>
      )}
      <button type="button" className="button button-secondary button-small" disabled={pending} onClick={close}>Cancel</button>
      {error && <span id={errorId} className="error-text" role="alert">{error}</span>}
    </form>
  );
}
