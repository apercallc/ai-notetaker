"use client";

import Link from "next/link";
import { FolderInput, Pencil, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { InlineName } from "./InlineName";
import { renameNoteAction } from "./libraryActions";
import { startDrag, useLibrary, type LibItem } from "./LibraryProvider";

const MAX_TITLE = 200;

/**
 * One note in the list. The title links to the note; press F2 or use the pencil
 * to rename in place; drag the card onto a folder to file it; Delete moves
 * it to Trash with Undo. `titleNode` is the (possibly search-highlighted) title
 * and `children` the server-rendered details under it.
 */
export function NoteRow({
  id,
  title,
  folderId,
  titleNode,
  children,
}: {
  id: string;
  title: string;
  folderId: string | null;
  titleNode: ReactNode;
  children: ReactNode;
}) {
  const library = useLibrary();
  const [localRenaming, setRenaming] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const closeRename = () => {
    setRenaming(false);
    library.requestRename(null);
    requestAnimationFrame(() => link.current?.focus());
  };
  const item: LibItem = { kind: "note", id, name: title, parentId: folderId };
  const renaming = localRenaming || library.renameKey === `${item.kind}:${item.id}`;
  const selected = library.isSelected(item);
  const subject = selected && library.selected.size > 1 ? `${library.selected.size} selected items` : title;
  const beingDragged = library.dragging?.some((entry) => entry.kind === "note" && entry.id === id) ?? false;

  async function save(next: string): Promise<string | null> {
    const formData = new FormData();
    formData.set("id", id);
    formData.set("title", next);
    const result = await renameNoteAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    if (result.ok) {
      closeRename();
      return null;
    }
    return result.error;
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    if (/^(INPUT|TEXTAREA|SELECT)$/u.test((event.target as HTMLElement).tagName)) return;
    if (event.key === "F2") { event.preventDefault(); setRenaming(true); }
    if (event.key === "Delete") { event.preventDefault(); library.trash(library.targetsFor(item)); }
  }

  function onClick(event: MouseEvent<HTMLLIElement>) {
    if ((event.target as HTMLElement).closest("input,button")) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      library.toggle(item);
    }
  }

  return (
    <li
      className={`meeting-card lib-card lib-row${selected ? " is-selected" : ""}${beingDragged ? " is-dragging" : ""}`}
      draggable={!renaming && !library.busy}
      onDragStart={(event) => startDrag(event, library, item)}
      onDragEnd={() => library.setDragging(null)}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <div className="title lib-title">
        <input type="checkbox" className="lib-check" checked={selected} onChange={() => library.toggle(item)} aria-label={`Select ${title}`} />
        {renaming ? (
          <InlineName value={title} label={`Rename note ${title}`} maxLength={MAX_TITLE} onSave={save} onCancel={closeRename} />
        ) : (
          <Link ref={link} href={`/meetings/${id}`} className="card-link">
            {titleNode}
          </Link>
        )}
      </div>
      {children}
      {!renaming && (
        <div className="card-actions row-actions">
          <button type="button" className="icon-button" onClick={() => setRenaming(true)} disabled={library.busy} aria-label={`Rename ${title}`} title="Rename (F2)" aria-keyshortcuts="F2"><Pencil size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => library.openMove(library.targetsFor(item))} disabled={library.busy} aria-label={`Move ${subject}`} title="Move to…"><FolderInput size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => library.trash(library.targetsFor(item))} disabled={library.busy} aria-label={`Delete ${subject}`} title="Move to Trash (Delete)"><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      )}
    </li>
  );
}
