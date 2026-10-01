"use client";

import { useState, useTransition } from "react";
import { moveNotesAction, trashNoteAction } from "./libraryActions";
import { MoveDialog } from "./MoveDialog";
import type { FlatFolder } from "@/lib/libraryTree";

/** Move and delete for one note in the library list. */
export function NoteActions({ id, title, folderId, folders }: { id: string; title: string; folderId: string | null; folders: FlatFolder[] }) {
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: typeof moveNotesAction, fields: Record<string, string>, done: () => void) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    setError(null);
    startTransition(async () => {
      let result;
      try {
        result = await action(formData);
      } catch {
        result = { ok: false as const, error: "Something went wrong. Try again." };
      }
      if (result.ok) done();
      else setError(result.error);
    });
  }

  return (
    <>
      <button type="button" className="button button-secondary button-small" onClick={() => { setMoving(true); setError(null); }} disabled={pending} aria-label={`Move ${title}`}>Move</button>
      <button
        type="button"
        className="button button-secondary button-small"
        disabled={pending}
        aria-label={`Delete ${title}`}
        onClick={() => {
          if (window.confirm(`Move "${title}" to Trash? You can restore it for 30 days.`)) run(trashNoteAction, { id }, () => undefined);
        }}
      >
        Delete
      </button>
      {error && !moving && <span className="error-text" role="alert">{error}</span>}
      <MoveDialog
        open={moving}
        onClose={() => setMoving(false)}
        title={`Move “${title}”`}
        folders={folders}
        currentId={folderId}
        busy={pending}
        error={error}
        onConfirm={(destination) => run(moveNotesAction, { id, folderId: destination ?? "" }, () => setMoving(false))}
      />
    </>
  );
}
