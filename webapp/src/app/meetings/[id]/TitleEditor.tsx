"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { renameMeetingAction } from "./actions";

const MAX_TITLE_LENGTH = 200;

/** The meeting title, editable in place. Enter saves, Escape cancels. */
export function TitleEditor({ meetingId, title }: { meetingId: string; title: string }) {
  const [saved, setSaved] = useState(title);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const renameButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // Put focus back on the Rename button when the editor closes, so keyboard
  // users don't get dropped at the top of the page.
  useEffect(() => {
    if (wasEditing.current && !editing) renameButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function begin() {
    setDraft(saved);
    setError(null);
    setEditing(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = draft.trim();
    if (next === saved) {
      setEditing(false);
      return;
    }
    const formData = new FormData();
    formData.set("id", meetingId);
    formData.set("title", next);
    startTransition(async () => {
      const result = await renameMeetingAction(formData);
      if (result.status === "saved") {
        setSaved(result.title);
        setEditing(false);
      } else {
        setError(result.message);
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <div className="title-row">
        <h1>{saved}</h1>
        <button ref={renameButton} type="button" className="text-link-muted" onClick={begin}>
          Rename
        </button>
      </div>
    );
  }

  return (
    <form className="title-edit" onSubmit={submit}>
      <label className="sr-only" htmlFor="meeting-title">Meeting title</label>
      <input
        id="meeting-title"
        className="text-input title-input"
        value={draft}
        maxLength={MAX_TITLE_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "meeting-title-error" : undefined}
        required
        autoFocus
        disabled={pending}
      />
      <button type="submit" className="button button-primary button-small" disabled={pending || draft.trim() === ""}>
        {pending ? "Saving…" : "Save"}
      </button>
      <button type="button" className="button button-secondary button-small" onClick={() => setEditing(false)} disabled={pending}>
        Cancel
      </button>
      {error && <p id="meeting-title-error" className="error-text" role="alert">{error}</p>}
    </form>
  );
}
