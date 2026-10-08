"use client";

import { FolderInput, Pencil, Trash2, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createFolderAction, moveItemsAction, restoreItemsAction, trashItemsAction, type BulkResult } from "./libraryActions";
import { MoveDialog } from "./MoveDialog";
import type { FlatFolder } from "@/lib/libraryTree";

/** One row of the library: a note or a folder. `subtree` (folders only) is the folder and everything inside it. */
export interface LibItem {
  kind: "note" | "folder";
  id: string;
  name: string;
  parentId: string | null;
  subtree?: string[];
}

const keyOf = (item: LibItem) => `${item.kind}:${item.id}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
  undo?: () => void;
}

interface LibraryContextValue {
  folders: FlatFolder[];
  currentFolderId: string | null;
  busy: boolean;
  selected: ReadonlyMap<string, LibItem>;
  isSelected: (item: LibItem) => boolean;
  toggle: (item: LibItem) => void;
  clearSelection: () => void;
  /** The items a gesture on `item` applies to: the whole selection when `item` is in it, otherwise just `item`. */
  targetsFor: (item: LibItem) => LibItem[];
  openMove: (items: LibItem[]) => void;
  trash: (items: LibItem[]) => void;
  moveTo: (items: LibItem[], destinationId: string | null, fromDialog?: boolean) => void;
  /** Set by the selection bar so a single selected row can be renamed in place. */
  renameKey: string | null;
  requestRename: (item: LibItem | null) => void;
  creatingFolder: boolean;
  setCreatingFolder: (value: boolean) => void;
  notify: (message: string, tone?: "info" | "error") => void;
  dragging: LibItem[] | null;
  setDragging: (items: LibItem[] | null) => void;
  canDrop: (destinationId: string | null) => boolean;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary must be used inside <LibraryProvider>");
  return value;
}

/** Whether `destinationId` is a legal place for all of `items` (not where they already are, not inside themselves). */
function legalDestination(items: readonly LibItem[], destinationId: string | null): boolean {
  if (items.length === 0) return false;
  return items.every((item) => item.parentId !== destinationId && !(item.kind === "folder" && destinationId !== null && (item.subtree ?? [item.id]).includes(destinationId)));
}

function idsForm(items: readonly LibItem[], extra: Record<string, string> = {}): FormData {
  const formData = new FormData();
  for (const item of items) formData.append(item.kind === "note" ? "noteId" : "folderId", item.id);
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return formData;
}

const DRAG_MIME = "application/x-notetaker-library";

/**
 * Props for any element that accepts dropped library rows (folder rows, the
 * breadcrumb). `isOver` drives the highlight.
 */
export function useDropTarget(destinationId: string | null) {
  const library = useLibrary();
  const [isOver, setIsOver] = useState(false);
  const valid = library.dragging !== null && library.canDrop(destinationId);
  return {
    isOver: isOver && valid,
    isValidTarget: valid,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!valid) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setIsOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOver(false);
      },
      onDrop: (event: DragEvent) => {
        setIsOver(false);
        if (!valid || !library.dragging) return;
        event.preventDefault();
        library.moveTo(library.dragging, destinationId);
        library.setDragging(null);
      },
    },
  };
}

/** Starts a drag of `item` (or of the whole selection when `item` is selected). */
export function startDrag(event: DragEvent, library: LibraryContextValue, item: LibItem): void {
  const items = library.targetsFor(item);
  // Grabbing the title link would otherwise drag the URL; drag the whole row instead.
  event.dataTransfer.clearData();
  event.dataTransfer.effectAllowed = "move";
  if (event.currentTarget instanceof HTMLElement) event.dataTransfer.setDragImage(event.currentTarget, 24, 20);
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(items.map(keyOf)));
  event.dataTransfer.setData("text/plain", items.map((entry) => entry.name).join("\n"));
  library.setDragging(items);
}

export function LibraryProvider({ folders, currentFolderId, children }: { folders: FlatFolder[]; currentFolderId: string | null; children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlyMap<string, LibItem>>(new Map());
  const [dragging, setDragging] = useState<LibItem[] | null>(null);
  const [moveItems, setMoveItems] = useState<LibItem[] | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const toastId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // A new view (another folder, a search, a page) starts with nothing selected.
  const viewKey = `${pathname}?${search}`;
  const [seenView, setSeenView] = useState(viewKey);
  if (seenView !== viewKey) {
    setSeenView(viewKey);
    setSelected(new Map());
    setCreatingFolder(false);
  }

  const dismiss = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const armTimer = useCallback((undoable: boolean) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), undoable ? 20_000 : 6_000);
  }, []);

  const notify = useCallback((message: string, tone: "info" | "error" = "info", undo?: () => void) => {
    // A plain confirmation must not wipe out an Undo the person may still want.
    if (toast?.undo && !undo && tone === "info") return;
    toastId.current += 1;
    setToast({ id: toastId.current, message, tone, ...(undo ? { undo } : {}) });
    armTimer(Boolean(undo));
  }, [armTimer, toast]);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const clearSelection = useCallback(() => setSelected(new Map()), []);

  const toggle = useCallback((item: LibItem) => {
    setSelected((current) => {
      const next = new Map(current);
      const key = keyOf(item);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  }, []);

  const targetsFor = useCallback((item: LibItem) => (selected.has(keyOf(item)) ? [...selected.values()] : [item]), [selected]);

  const folderName = useCallback((id: string | null) => (id === null ? "Library" : folders.find((folder) => folder.id === id)?.name ?? "that folder"), [folders]);

  const send = useCallback(async (action: (formData: FormData) => Promise<BulkResult>, formData: FormData): Promise<BulkResult> => {
    try {
      return await action(formData);
    } catch {
      return { ok: false, error: "Something went wrong. Try again." };
    }
  }, []);

  const moveTo = useCallback(async (items: LibItem[], destinationId: string | null, fromDialog = false) => {
    if (!legalDestination(items, destinationId)) return;
    setBusy(true);
    setDialogError(null);
    const result = await send(moveItemsAction, idsForm(items, { destination: destinationId ?? "" }));
    setBusy(false);
    if (!result.ok) {
      setDialogError(result.error);
      if (!fromDialog) notify(result.error, "error");
      return;
    }
    setMoveItems(null);
    clearSelection();
    const where = folderName(destinationId);
    const base = items.length === 1 ? `Moved “${items[0]!.name}” to ${where}.` : `Moved ${plural(result.done, "item", "items")} to ${where}.`;
    const undo = async () => {
      dismiss();
      // Put each item back where it came from (items may have come from different folders).
      const byParent = new Map<string | null, LibItem[]>();
      for (const item of items) byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
      for (const [parent, group] of byParent) await send(moveItemsAction, idsForm(group, { destination: parent ?? "" }));
      notify("Move undone.");
    };
    notify(result.failed > 0 && result.error ? `${base} ${plural(result.failed, "item", "items")} couldn’t move: ${result.error}` : base, "info", undo);
  }, [clearSelection, dismiss, folderName, notify, send]);

  const trash = useCallback(async (items: LibItem[]) => {
    if (items.length === 0) return;
    setBusy(true);
    const result = await send(trashItemsAction, idsForm(items));
    setBusy(false);
    if (!result.ok) {
      notify(result.error, "error");
      return;
    }
    clearSelection();
    const undo = async () => {
      dismiss();
      const formData = new FormData();
      for (const item of items) formData.append("item", `${item.kind}:${item.id}`);
      const restored = await restoreItemsAction(formData).catch(() => ({ ok: false as const, error: "Couldn’t restore. Open Trash to recover it." }));
      notify(restored.ok ? "Restored." : restored.error, restored.ok ? "info" : "error");
    };
    notify(result.failed > 0 && result.error ? `${result.message} ${plural(result.failed, "item", "items")} couldn’t be deleted: ${result.error}` : result.message, "info", undo);
  }, [clearSelection, dismiss, notify, send]);

  const canDrop = useCallback((destinationId: string | null) => dragging !== null && legalDestination(dragging, destinationId), [dragging]);

  // Ctrl/Cmd+Z runs the Undo of the last move or delete while its toast is showing.
  useEffect(() => {
    if (!toast?.undo) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z" && !(target && /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName) || target?.isContentEditable)) {
        event.preventDefault();
        toast.undo?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toast]);

  // Escape clears the selection; Ctrl/Cmd+A selects nothing special so it keeps its normal meaning.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && !moveItems && !(target && /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) clearSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.size, moveItems, clearSelection]);

  const value = useMemo<LibraryContextValue>(() => ({
    folders,
    currentFolderId,
    busy,
    selected,
    isSelected: (item) => selected.has(keyOf(item)),
    toggle,
    clearSelection,
    targetsFor,
    openMove: (items) => { setDialogError(null); setMoveItems(items); },
    trash,
    moveTo,
    renameKey,
    requestRename: (item) => setRenameKey(item ? keyOf(item) : null),
    creatingFolder,
    setCreatingFolder,
    notify,
    dragging,
    setDragging,
    canDrop,
  }), [folders, currentFolderId, busy, selected, toggle, clearSelection, targetsFor, trash, moveTo, renameKey, creatingFolder, notify, dragging, canDrop]);

  const selection = [...selected.values()];
  const moveExclude = (moveItems ?? []).flatMap((item) => (item.kind === "folder" ? item.subtree ?? [item.id] : []));
  const parents = new Set((moveItems ?? []).map((item) => item.parentId));
  const sharedParent = parents.size === 1 ? [...parents][0]! : undefined;

  return (
    <LibraryContext.Provider value={value}>
      <div className="lib-scope" data-selecting={selection.length > 0 ? "true" : undefined}>{children}</div>

      {selection.length > 0 && (
        <div className="selection-bar" role="region" aria-label="Selected items">
          <span className="selection-count" role="status">{selection.length} selected</span>
          {selection.length === 1 && (
            <button type="button" className="button button-secondary button-small" onClick={() => { setRenameKey(keyOf(selection[0]!)); clearSelection(); }} disabled={busy}>
              <Pencil size={16} strokeWidth={1.75} aria-hidden="true" /> Rename
            </button>
          )}
          <button type="button" className="button button-secondary button-small" onClick={() => { setDialogError(null); setMoveItems(selection); }} disabled={busy}>
            <FolderInput size={16} strokeWidth={1.75} aria-hidden="true" /> Move to…
          </button>
          <button type="button" className="button button-danger button-small" onClick={() => void trash(selection)} disabled={busy}>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /> Delete
          </button>
          <button type="button" className="icon-button" onClick={clearSelection} aria-label="Clear selection" title="Clear selection (Esc)">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}

      {toast && (
        <div
          className={`library-toast${toast.tone === "error" ? " is-error" : ""}${selection.length > 0 ? " above-bar" : ""}`}
          role={toast.tone === "error" ? "alert" : "status"}
          onMouseEnter={() => { if (toastTimer.current) clearTimeout(toastTimer.current); }}
          onMouseLeave={() => armTimer(Boolean(toast.undo))}
          onFocus={() => { if (toastTimer.current) clearTimeout(toastTimer.current); }}
          onBlur={() => armTimer(Boolean(toast.undo))}
        >
          <span>{toast.message}</span>
          {toast.undo && <button type="button" className="toast-action" onClick={toast.undo} aria-keyshortcuts="Control+Z Meta+Z">Undo</button>}
          <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss"><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      )}

      <MoveDialog
        open={moveItems !== null}
        onClose={() => setMoveItems(null)}
        title={moveItems && moveItems.length === 1 ? `Move “${moveItems[0]!.name}”` : `Move ${moveItems?.length ?? 0} items`}
        folders={folders}
        excludeIds={moveExclude}
        currentId={sharedParent}
        busy={busy}
        error={dialogError}
        onCreateFolder={async (parentId, name) => {
          const formData = new FormData();
          formData.set("parentId", parentId ?? "");
          formData.set("name", name);
          const result = await createFolderAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
          return result.ok && result.id ? { ok: true as const, id: result.id } : { ok: false as const, error: result.ok ? "Couldn’t create the folder." : result.error };
        }}
        onConfirm={(destination) => { if (moveItems) void moveTo(moveItems, destination, true); }}
      />
    </LibraryContext.Provider>
  );
}
