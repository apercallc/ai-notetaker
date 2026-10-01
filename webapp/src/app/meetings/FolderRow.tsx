"use client";

import Link from "next/link";
import { Folder } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { moveFolderAction, renameFolderAction, trashFolderAction } from "./libraryActions";
import { MoveDialog } from "./MoveDialog";
import { MAX_FOLDER_NAME, type FlatFolder } from "@/lib/libraryTree";

export function FolderRow({
  id,
  name,
  parentId,
  href,
  noteCount,
  subfolderCount,
  folders,
  excludeIds,
}: {
  id: string;
  name: string;
  parentId: string | null;
  href: string;
  noteCount: number;
  subfolderCount: number;
  folders: FlatFolder[];
  /** This folder and everything inside it: it cannot be moved into itself. */
  excludeIds: string[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: (formData: FormData) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, fields: Record<string, string>, done: () => void) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      let result;
      try {
        result = await action(formData);
      } catch {
        result = { ok: false as const, error: "Something went wrong. Try again." };
      }
      if (result.ok) {
        done();
        if (result.message) setNotice(result.message);
      } else {
        setError(result.error);
      }
    });
  }

  function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("name") ?? "");
    run(renameFolderAction, { id, name: next }, () => setRenaming(false));
  }

  function onDelete() {
    const contents = [
      noteCount === 1 ? "1 note" : `${noteCount} notes`,
      ...(subfolderCount > 0 ? [subfolderCount === 1 ? "1 folder" : `${subfolderCount} folders`] : []),
    ].join(" and ");
    if (!window.confirm(`Delete "${name}" and everything in it (${contents})? It moves to Trash and can be restored for 30 days.`)) return;
    run(trashFolderAction, { id }, () => undefined);
  }

  return (
    <li className="folder-row">
      {renaming ? (
        <form className="folder-rename" onSubmit={onRename}>
          <label className="sr-only" htmlFor={`rename-${id}`}>Folder name</label>
          <input id={`rename-${id}`} name="name" className="text-input" defaultValue={name} maxLength={MAX_FOLDER_NAME} autoFocus disabled={pending} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(false); }} />
          <button type="submit" className="button button-primary button-small" disabled={pending}>Save</button>
          <button type="button" className="button button-secondary button-small" onClick={() => setRenaming(false)} disabled={pending}>Cancel</button>
        </form>
      ) : (
        <>
          <Link href={href} className="folder-link">
            <Folder size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="folder-name">{name}</span>
            <span className="muted-copy folder-count">{noteCount === 1 ? "1 note" : `${noteCount} notes`}{subfolderCount > 0 ? ` · ${subfolderCount === 1 ? "1 folder" : `${subfolderCount} folders`}` : ""}</span>
          </Link>
          <span className="folder-actions">
            <button type="button" className="button button-secondary button-small" onClick={() => { setRenaming(true); setError(null); }} disabled={pending} aria-label={`Rename ${name}`}>Rename</button>
            <button type="button" className="button button-secondary button-small" onClick={() => { setMoving(true); setError(null); }} disabled={pending} aria-label={`Move ${name}`}>Move</button>
            <button type="button" className="button button-secondary button-small" onClick={onDelete} disabled={pending} aria-label={`Delete ${name}`}>Delete</button>
          </span>
        </>
      )}
      {(error || notice) && <p className={error ? "error-text folder-message" : "muted-copy folder-message"} role={error ? "alert" : "status"}>{error ?? notice}</p>}
      <MoveDialog
        open={moving}
        onClose={() => setMoving(false)}
        title={`Move “${name}”`}
        folders={folders}
        excludeIds={excludeIds}
        currentId={parentId}
        busy={pending}
        error={error}
        onConfirm={(destination) => run(moveFolderAction, { id, parentId: destination ?? "" }, () => setMoving(false))}
      />
    </li>
  );
}
