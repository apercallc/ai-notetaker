"use client";

import Link from "next/link";
import { FilePlus, FolderPlus, Trash2, Upload } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { createNoteAction, uploadNoteAction } from "./libraryActions";
import { useLibrary } from "./LibraryProvider";
import { MAX_NOTE_UPLOAD_BYTES } from "@/lib/noteEditing.shared";

function NewNoteButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary button-small" disabled={pending} aria-busy={pending}>
      <FilePlus size={16} strokeWidth={1.75} aria-hidden="true" /> {pending ? "Creating…" : "New note"}
    </button>
  );
}

export function LibraryToolbar({ folderId, canImport, canCreateFolder, showHint }: { folderId: string | null; canImport: boolean; canCreateFolder: boolean; showHint: boolean }) {
  const router = useRouter();
  const library = useLibrary();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_NOTE_UPLOAD_BYTES) {
      setError(`That file is too large. The limit is ${MAX_NOTE_UPLOAD_BYTES / 1024} KB.`);
      return;
    }
    const body = await file.text();
    const formData = new FormData();
    formData.set("fileName", file.name);
    formData.set("body", body);
    formData.set("folderId", folderId ?? "");
    startTransition(async () => {
      const result = await uploadNoteAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
      if (result.ok && result.id) router.push(`/meetings/${result.id}`);
      else if (!result.ok) setError(result.error);
    });
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <div className="library-toolbar">
      <div className="library-toolbar-row">
        <form action={createNoteAction}>
          <input type="hidden" name="folderId" value={folderId ?? ""} />
          <NewNoteButton />
        </form>
        <button type="button" className="button button-secondary button-small" onClick={() => { library.setCreatingFolder(true); setError(null); }} disabled={pending || !canCreateFolder} title={canCreateFolder ? undefined : "Clear the search to add folders"}>
          <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" /> New folder
        </button>
        <button type="button" className="button button-secondary button-small" onClick={() => fileInput.current?.click()} disabled={pending}>
          <Upload size={16} strokeWidth={1.75} aria-hidden="true" /> {pending ? "Working…" : "Upload .md or .txt"}
        </button>
        <input ref={fileInput} className="sr-only" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" tabIndex={-1} aria-hidden="true" onChange={(event) => void onFile(event.target.files?.[0])} />
        {canImport && <Link className="button button-secondary button-small" href="/import">Import a recording</Link>}
        <Link className="button button-secondary button-small" href="/trash"><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /> Trash</Link>
      </div>
      {showHint && <p className="lib-hint muted-copy">Drag notes and folders onto a folder to move them · press F2 (or the pencil) to rename · Ctrl/⌘-click to select several</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
