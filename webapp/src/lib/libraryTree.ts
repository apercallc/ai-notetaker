// Pure folder-tree helpers shared by the library page, the move dialog and the
// server. No database imports, so client components can use them.

export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
}

export const MAX_FOLDER_DEPTH = 8;
export const MAX_FOLDER_NAME = 80;
export const MAX_FOLDERS_PER_WORKSPACE = 2_000;

/** Collapses whitespace; returns an error message instead of a name when it is not usable. */
export function validateFolderName(raw: string): { name: string } | { error: string } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { error: "Enter a folder name." };
  if (name.length > MAX_FOLDER_NAME) return { error: `Use ${MAX_FOLDER_NAME} characters or fewer.` };
  if (/[/\\\u0000-\u001f\u007f]/u.test(name)) return { error: "Folder names can't contain / or \\." };
  if (name === "." || name === "..") return { error: "Choose a different name." };
  return { name };
}

function byId(folders: readonly FolderNode[]): Map<string, FolderNode> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

/** Root-first chain of folders ending at `id` (empty for the top level or an unknown id). */
export function folderPath(folders: readonly FolderNode[], id: string | null): FolderNode[] {
  const index = byId(folders);
  const path: FolderNode[] = [];
  const seen = new Set<string>();
  for (let current = id ? index.get(id) : undefined; current && !seen.has(current.id); current = current.parentId ? index.get(current.parentId) : undefined) {
    seen.add(current.id);
    path.unshift(current);
  }
  return path;
}

/** 1 for a top-level folder; 0 for the top level itself. */
export function folderDepth(folders: readonly FolderNode[], id: string | null): number {
  return folderPath(folders, id).length;
}

/** `id` and every folder below it. */
export function subtreeIds(folders: readonly FolderNode[], id: string): string[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder.id]);
  }
  const result: string[] = [];
  const queue = [id];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return result;
}

/** Levels in the subtree rooted at `id`, counting `id` itself (a leaf folder is 1). */
export function subtreeHeight(folders: readonly FolderNode[], id: string): number {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder.id]);
  }
  const seen = new Set<string>();
  const height = (node: string): number => {
    if (seen.has(node)) return 0;
    seen.add(node);
    return 1 + Math.max(0, ...(children.get(node) ?? []).map(height));
  };
  return height(id);
}

export interface FlatFolder {
  id: string;
  name: string;
  depth: number;
  /** "Clients / Acme / 2026" */
  path: string;
}

/** Depth-first, alphabetical flattening for pickers and path labels. */
export function flattenFolders(folders: readonly FolderNode[]): FlatFolder[] {
  const children = new Map<string | null, FolderNode[]>();
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  const out: FlatFolder[] = [];
  const walk = (parentId: string | null, depth: number, prefix: string) => {
    for (const folder of [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
      out.push({ id: folder.id, name: folder.name, depth, path });
      walk(folder.id, depth + 1, path);
    }
  };
  walk(null, 0, "");
  return out;
}

/** The "A / B / C" label for a folder, or "" for the top level. */
export function folderPathLabel(folders: readonly FolderNode[], id: string | null): string {
  return folderPath(folders, id).map((folder) => folder.name).join(" / ");
}
