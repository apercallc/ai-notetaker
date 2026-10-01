"use client";

import { useEffect, useRef, useState } from "react";
import type { FlatFolder } from "@/lib/libraryTree";

/**
 * Pick a destination folder. A native <dialog>, so focus is trapped, Escape
 * closes it and the page behind is inert without extra code.
 */
export function MoveDialog({
  open,
  onClose,
  title,
  folders,
  excludeIds = [],
  currentId,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  folders: FlatFolder[];
  /** Folders that cannot be chosen (a folder's own subtree). */
  excludeIds?: string[];
  currentId: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: (destination: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string>(currentId ?? "");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected(currentId ?? "");
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open, currentId]);

  return (
    <dialog ref={dialog} className="move-dialog" aria-labelledby="move-dialog-title" onClose={onClose}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(selected === "" ? null : selected); }}>
        <h2 id="move-dialog-title">{title}</h2>
        <fieldset className="move-options">
          <legend className="sr-only">Destination</legend>
          <label className="move-option">
            <input type="radio" name="destination" value="" checked={selected === ""} onChange={() => setSelected("")} />
            <span>Library (top level)</span>
          </label>
          {folders.map((folder) => {
            const blocked = excludeIds.includes(folder.id);
            return (
              <label key={folder.id} className={`move-option${blocked ? " is-disabled" : ""}`} style={{ paddingLeft: `${12 + folder.depth * 18}px` }}>
                <input type="radio" name="destination" value={folder.id} checked={selected === folder.id} disabled={blocked} onChange={() => setSelected(folder.id)} />
                <span>{folder.name}</span>
              </label>
            );
          })}
        </fieldset>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="move-actions">
          <button type="submit" className="button button-primary" disabled={busy || selected === (currentId ?? "")} aria-busy={busy}>{busy ? "Moving…" : "Move here"}</button>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
