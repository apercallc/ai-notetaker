"use client";

import { Folder } from "lucide-react";
import type { ReactNode } from "react";
import { InlineName } from "./InlineName";
import { createFolderAction } from "./libraryActions";
import { useLibrary } from "./LibraryProvider";
import { MAX_FOLDER_NAME } from "@/lib/libraryTree";

/** The folder list, with a Finder-style empty row at the top while a new folder is being named. */
export function FolderList({ hasRows, children }: { hasRows: boolean; children: ReactNode }) {
  const library = useLibrary();
  if (!hasRows && !library.creatingFolder) return null;

  async function create(name: string): Promise<string | null> {
    const formData = new FormData();
    formData.set("parentId", library.currentFolderId ?? "");
    formData.set("name", name);
    const result = await createFolderAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    if (result.ok) {
      library.setCreatingFolder(false);
      library.notify(`Created folder “${result.name ?? name}”.`);
      return null;
    }
    return result.error;
  }

  return (
    <ul className="folder-list" aria-label="Folders">
      {library.creatingFolder && (
        <li className="folder-row lib-row is-new">
          <span className="folder-link">
            <Folder size={18} strokeWidth={1.75} aria-hidden="true" />
            <InlineName value="" label="New folder name" placeholder="Folder name" maxLength={MAX_FOLDER_NAME} onSave={create} onCancel={() => library.setCreatingFolder(false)} />
          </span>
        </li>
      )}
      {children}
    </ul>
  );
}
