"use client";

import { Pencil } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
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
      if (result.status === "saved") setEditing(false);
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
        type="button"
        className={`speaker speaker-button${isYou ? " is-you" : ""}`}
        onClick={() => { setEditing(true); setError(null); setTimeout(() => input.current?.select(), 0); }}
        aria-label={`Rename ${label}`}
        title="Rename this speaker"
      >
        {label}
        <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    );
  }

  return (
    <form className="speaker-edit" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={`speaker-${speakerKey}`}>Name for {label}</label>
      <input
        ref={input}
        id={`speaker-${speakerKey}`}
        name="name"
        className="text-input"
        defaultValue={renamed ? label : ""}
        placeholder={renamed ? undefined : label}
        maxLength={MAX_SPEAKER_NAME}
        autoFocus
        disabled={pending}
        onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
      />
      <button type="submit" className="button button-primary button-small" disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</button>
      {renamed && (
        <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => save("")}>Reset</button>
      )}
      <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
      {error && <span className="error-text" role="alert">{error}</span>}
    </form>
  );
}
