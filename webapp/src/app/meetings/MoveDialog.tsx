"use client";

import { FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_FOLDER_NAME, type FlatFolder } from "@/lib/libraryTree";

/**
 * Pick a destination folder. A native <dialog>, so focus is trapped, Escape
 * closes it and the page behind is inert without extra code. Long folder
 * lists get a filter, double-clicking a folder moves straight there, and a new
 * folder can be made in place without leaving the dialog.
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
  onCreateFolder,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  folders: FlatFolder[];
  /** Folders that cannot be chosen (a folder's own subtree). */
  excludeIds?: string[];
  /** Where the items are now (`undefined` when they come from several places). */
  currentId: string | null | undefined;
  busy: boolean;
  error: string | null;
  onConfirm: (destination: string | null) => void;
  onCreateFolder?: (parentId: string | null, name: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<string>(currentId ?? "");
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setPicked(currentId ?? "");
      setPendingSelect(null);
      setFilter("");
      setCreating(false);
      setCreateError(null);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open, currentId]);

  // A folder made in the dialog appears once the page data refreshes; it is the selection from then on.
  const selected = pendingSelect && folders.some((folder) => folder.id === pendingSelect) ? pendingSelect : picked;
  const choose = (id: string) => { setPicked(id); setPendingSelect(null); };

  const needle = filter.trim().toLowerCase();
  const visible = needle ? folders.filter((folder) => folder.path.toLowerCase().includes(needle)) : folders;
  const unchanged = currentId !== undefined && selected === (currentId ?? "");
  const selectedName = selected === "" ? "Library" : folders.find((folder) => folder.id === selected)?.name ?? "this folder";

  const newName = useRef<HTMLInputElement>(null);

  async function onNewFolder() {
    if (!onCreateFolder) return;
    const name = newName.current?.value ?? "";
    setCreatingBusy(true);
    setCreateError(null);
    const result = await onCreateFolder(selected === "" ? null : selected, name);
    setCreatingBusy(false);
    if (result.ok) {
      setCreating(false);
      setFilter("");
      setPendingSelect(result.id);
    } else {
      setCreateError(result.error);
    }
  }

  return (
    <dialog ref={dialog} className="move-dialog" aria-labelledby="move-dialog-title" onClose={onClose}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (!unchanged) onConfirm(selected === "" ? null : selected); }}>
        <h2 id="move-dialog-title">{title}</h2>
        {folders.length > 8 && (
          <>
            <label className="sr-only" htmlFor="move-filter">Filter folders</label>
            <input id="move-filter" type="search" className="text-input move-filter" placeholder="Filter folders" value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                // Enter picks the first match instead of submitting the previous choice.
                if (event.key !== "Enter") return;
                event.preventDefault();
                const first = visible.find((folder) => !excludeIds.includes(folder.id));
                if (first) choose(first.id);
              }}
              autoComplete="off"
            />
          </>
        )}
        <fieldset className="move-options">
          <legend className="sr-only">Destination</legend>
          {!needle && (
            <label className="move-option" onDoubleClick={() => { if (currentId !== null) onConfirm(null); }}>
              <input type="radio" name="destination" value="" checked={selected === ""} onChange={() => choose("")} />
              <span>Library (top level)</span>
              {currentId === null && <span className="muted-copy move-here">current</span>}
            </label>
          )}
          {visible.map((folder) => {
            const blocked = excludeIds.includes(folder.id);
            return (
              <label
                key={folder.id}
                className={`move-option${blocked ? " is-disabled" : ""}`}
                style={{ paddingLeft: needle ? undefined : `${12 + folder.depth * 18}px` }}
                onDoubleClick={() => { if (!blocked && currentId !== folder.id) onConfirm(folder.id); }}
              >
                <input type="radio" name="destination" value={folder.id} checked={selected === folder.id} disabled={blocked} onChange={() => choose(folder.id)} />
                <span>{needle ? folder.path : folder.name}</span>
                {currentId === folder.id && <span className="muted-copy move-here">current</span>}
              </label>
            );
          })}
          {folders.length === 0 && <p className="muted-copy move-empty">No folders yet. Create one below.</p>}
          {needle && visible.length === 0 && <p className="muted-copy move-empty">No folder matches “{filter.trim()}”.</p>}
        </fieldset>

        {onCreateFolder && (creating ? (
          <div className="move-new">
            <div className="folder-rename">
              <label className="sr-only" htmlFor="move-new-name">{`New folder inside ${selectedName}`}</label>
              <input
                ref={newName}
                id="move-new-name"
                className="text-input"
                placeholder={`New folder in ${selectedName}`}
                maxLength={MAX_FOLDER_NAME}
                autoFocus
                disabled={creatingBusy}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void onNewFolder(); }
                  if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setCreating(false); }
                }}
              />
              <button type="button" className="button button-secondary button-small" onClick={() => void onNewFolder()} disabled={creatingBusy} aria-busy={creatingBusy}>Create</button>
              <button type="button" className="button button-secondary button-small" onClick={() => setCreating(false)} disabled={creatingBusy}>Cancel</button>
            </div>
            {createError && <p className="error-text" role="alert">{createError}</p>}
          </div>
        ) : (
          <button type="button" className="button button-secondary button-small move-new-button" onClick={() => { setCreating(true); setCreateError(null); }} disabled={busy}>
            <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" /> New folder in {selectedName}
          </button>
        ))}

        {error && <p className="error-text" role="alert">{error}</p>}
        {unchanged && <p className="muted-copy move-why">Already in {selectedName}. Choose a different folder.</p>}
        <div className="move-actions">
          <button type="submit" className="button button-primary" disabled={busy || unchanged} aria-busy={busy}>{busy ? "Moving…" : `Move to ${selectedName}`}</button>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
