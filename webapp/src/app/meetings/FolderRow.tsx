"use client";

import Link from "next/link";
import { Folder, FolderInput, Pencil, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { InlineName } from "./InlineName";
import { renameFolderAction } from "./libraryActions";
import { startDrag, useDropTarget, useLibrary, type LibItem } from "./LibraryProvider";
import { MAX_FOLDER_NAME } from "@/lib/libraryTree";

/**
 * One folder in the list. Click to open; drag it onto another folder to move
 * it; drop notes or folders on it to file them inside; press F2 or use the pencil
 * to rename; Delete moves it to Trash (with Undo).
 */
export function FolderRow({
  id,
  name,
  parentId,
  href,
  noteCount,
  subfolderCount,
  subtree,
}: {
  id: string;
  name: string;
  parentId: string | null;
  href: string;
  noteCount: number;
  subfolderCount: number;
  /** This folder and everything inside it: it cannot be moved into itself. */
  subtree: string[];
}) {
  const library = useLibrary();
  const [localRenaming, setRenaming] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const closeRename = () => {
    setRenaming(false);
    library.requestRename(null);
    requestAnimationFrame(() => link.current?.focus());
  };
  const item: LibItem = { kind: "folder", id, name, parentId, subtree };
  const renaming = localRenaming || library.renameKey === `${item.kind}:${item.id}`;
  const selected = library.isSelected(item);
  const subject = selected && library.selected.size > 1 ? `${library.selected.size} selected items` : name;
  const drop = useDropTarget(id);
  const beingDragged = library.dragging?.some((entry) => entry.kind === "folder" && entry.id === id) ?? false;

  async function save(next: string): Promise<string | null> {
    const formData = new FormData();
    formData.set("id", id);
    formData.set("name", next);
    const result = await renameFolderAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
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

  const counts = `${noteCount === 1 ? "1 note" : `${noteCount} notes`}${subfolderCount > 0 ? ` · ${subfolderCount === 1 ? "1 folder" : `${subfolderCount} folders`}` : ""}`;

  return (
    <li
      className={`folder-row lib-row${selected ? " is-selected" : ""}${drop.isOver ? " is-drop-over" : ""}${drop.isValidTarget ? " is-drop-target" : ""}${beingDragged ? " is-dragging" : ""}`}
      draggable={!renaming && !library.busy}
      onDragStart={(event) => startDrag(event, library, item)}
      onDragEnd={() => library.setDragging(null)}
      onKeyDown={onKeyDown}
      onClick={onClick}
      {...drop.props}
    >
      <input type="checkbox" className="lib-check" checked={selected} onChange={() => library.toggle(item)} aria-label={`Select folder ${name}`} />
      {renaming ? (
        <span className="folder-link">
          <Folder size={18} strokeWidth={1.75} aria-hidden="true" />
          <InlineName value={name} label={`Rename folder ${name}`} maxLength={MAX_FOLDER_NAME} onSave={save} onCancel={closeRename} />
        </span>
      ) : (
        <Link ref={link} href={href} className="folder-link">
          <Folder size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="folder-name">{name}</span>
          <span className="muted-copy folder-count">{counts}</span>
        </Link>
      )}
      {!renaming && (
        <span className="folder-actions row-actions">
          <button type="button" className="icon-button" onClick={() => setRenaming(true)} disabled={library.busy} aria-label={`Rename ${name}`} title="Rename (F2)" aria-keyshortcuts="F2"><Pencil size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => library.openMove(library.targetsFor(item))} disabled={library.busy} aria-label={`Move ${subject}`} title="Move to…"><FolderInput size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => library.trash(library.targetsFor(item))} disabled={library.busy} aria-label={`Delete ${subject}`} title="Move to Trash (Delete)"><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </span>
      )}
    </li>
  );
}
