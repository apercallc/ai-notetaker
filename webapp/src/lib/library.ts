import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { recordAudit } from "./audit";
import { deleteMeeting } from "./meetings";
import {
  MAX_FOLDERS_PER_WORKSPACE,
  MAX_FOLDER_DEPTH,
  folderDepth,
  subtreeHeight,
  subtreeIds,
  validateFolderName,
  type FolderNode,
} from "./libraryTree";

/**
 * The library: nested folders, notes placed in them, and a Trash.
 *
 * Folders are workspace-wide like the notes themselves; there is no per-folder
 * access control. Deleting moves an item (and, for a folder, everything inside
 * it) to Trash for TRASH_RETENTION_DAYS. Every item that left with a deletion
 * carries that deletion's `trashRootId`, so restoring the folder returns
 * exactly what went with it and nothing trashed separately earlier.
 */
export const TRASH_RETENTION_DAYS = 30;
export const MAX_MOVE_BATCH = 200;

export interface LibrarySession {
  workspaceId: string;
  userId: string;
  role: "owner" | "member";
}

export type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "P2002" || code === "23505" || (typeof message === "string" && /duplicate key|unique constraint/iu.test(message));
}

/** Every live folder of the workspace (bounded). */
export async function listFolders(workspaceId: string): Promise<FolderNode[]> {
  return prisma.folder.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentId: true, name: true },
    orderBy: { name: "asc" },
    take: MAX_FOLDERS_PER_WORKSPACE + 1,
  });
}

export async function createFolder(session: LibrarySession, parentId: string | null, rawName: string): Promise<{ ok: true; id: string; name: string } | Fail> {
  const checked = validateFolderName(rawName);
  if ("error" in checked) return fail(checked.error);
  const folders = await listFolders(session.workspaceId);
  if (folders.length >= MAX_FOLDERS_PER_WORKSPACE) return fail(`A library can hold ${MAX_FOLDERS_PER_WORKSPACE} folders. Delete some before adding more.`);
  if (parentId && !folders.some((folder) => folder.id === parentId)) return fail("That folder no longer exists.");
  if (folderDepth(folders, parentId) + 1 > MAX_FOLDER_DEPTH) return fail(`Folders can be nested ${MAX_FOLDER_DEPTH} levels deep.`);
  try {
    const created = await prisma.folder.create({
      data: { workspaceId: session.workspaceId, parentId, name: checked.name, createdByUserId: session.userId },
      select: { id: true, name: true },
    });
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "folder.create", targetType: "folder", targetId: created.id });
    return { ok: true, ...created };
  } catch (error) {
    if (isUniqueViolation(error)) return fail("A folder with that name already exists here.");
    throw error;
  }
}

export async function renameFolder(session: LibrarySession, id: string, rawName: string): Promise<{ ok: true; name: string } | Fail> {
  const checked = validateFolderName(rawName);
  if ("error" in checked) return fail(checked.error);
  try {
    const updated = await prisma.folder.updateMany({ where: { id, workspaceId: session.workspaceId, deletedAt: null }, data: { name: checked.name } });
    if (updated.count !== 1) return fail("That folder no longer exists.");
  } catch (error) {
    if (isUniqueViolation(error)) return fail("A folder with that name already exists here.");
    throw error;
  }
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "folder.rename", targetType: "folder", targetId: id });
  return { ok: true, name: checked.name };
}

/** Moves a folder under another folder, or to the top level with `newParentId = null`. */
export async function moveFolder(session: LibrarySession, id: string, newParentId: string | null): Promise<{ ok: true } | Fail> {
  const folders = await listFolders(session.workspaceId);
  const folder = folders.find((candidate) => candidate.id === id);
  if (!folder) return fail("That folder no longer exists.");
  if (folder.parentId === newParentId) return { ok: true };
  if (newParentId !== null) {
    if (!folders.some((candidate) => candidate.id === newParentId)) return fail("The destination folder no longer exists.");
    if (subtreeIds(folders, id).includes(newParentId)) return fail("A folder can't be moved into itself or one of its own folders.");
  }
  if (folderDepth(folders, newParentId) + subtreeHeight(folders, id) > MAX_FOLDER_DEPTH) return fail(`Folders can be nested ${MAX_FOLDER_DEPTH} levels deep.`);
  try {
    const moved = await prisma.folder.updateMany({ where: { id, workspaceId: session.workspaceId, deletedAt: null }, data: { parentId: newParentId } });
    if (moved.count !== 1) return fail("That folder no longer exists.");
  } catch (error) {
    if (isUniqueViolation(error)) return fail("The destination already has a folder with that name.");
    throw error;
  }
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "folder.move", targetType: "folder", targetId: id });
  return { ok: true };
}

/** Places notes in a folder, or at the top level with `folderId = null`. Trashed notes are left alone. */
export async function moveNotes(session: LibrarySession, meetingIds: string[], folderId: string | null): Promise<{ ok: true; moved: number } | Fail> {
  const ids = [...new Set(meetingIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))];
  if (ids.length === 0) return fail("Choose at least one note.");
  if (ids.length > MAX_MOVE_BATCH) return fail(`Move up to ${MAX_MOVE_BATCH} notes at a time.`);
  if (folderId !== null && !(await prisma.folder.findFirst({ where: { id: folderId, workspaceId: session.workspaceId, deletedAt: null }, select: { id: true } }))) {
    return fail("The destination folder no longer exists.");
  }
  const result = await prisma.meeting.updateMany({ where: { id: { in: ids }, workspaceId: session.workspaceId, deletedAt: null }, data: { folderId } });
  if (result.count > 0) {
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.move", targetType: "folder", targetId: folderId ?? undefined, metadata: { count: result.count, toTopLevel: folderId === null } });
  }
  return { ok: true, moved: result.count };
}

/** Owners may trash anything; a member may trash their own notes. */
export function canTrashNote(session: LibrarySession, authorUserId: string): boolean {
  return session.role === "owner" || authorUserId === session.userId;
}

export async function trashNote(session: LibrarySession, id: string): Promise<{ ok: true } | Fail> {
  const note = await prisma.meeting.findFirst({ where: { id, workspaceId: session.workspaceId, deletedAt: null }, select: { userId: true } });
  if (!note) return fail("This note no longer exists.");
  if (!canTrashNote(session, note.userId)) return fail("Only the person who wrote this note, or a workspace owner, can delete it.");
  await prisma.meeting.updateMany({ where: { id, workspaceId: session.workspaceId, deletedAt: null }, data: { deletedAt: new Date(), trashRootId: id } });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.trash", targetType: "meeting", targetId: id });
  return { ok: true };
}

/**
 * Trashes a folder with every folder and note inside it. A member may do this
 * only when everything inside was created by them; otherwise an owner must.
 */
export async function trashFolder(session: LibrarySession, id: string): Promise<{ ok: true; folders: number; notes: number } | Fail> {
  const all = await prisma.folder.findMany({ where: { workspaceId: session.workspaceId, deletedAt: null }, select: { id: true, parentId: true, name: true, createdByUserId: true }, take: MAX_FOLDERS_PER_WORKSPACE + 1 });
  if (!all.some((folder) => folder.id === id)) return fail("That folder no longer exists.");
  const tree = subtreeIds(all, id);
  const notes = await prisma.meeting.findMany({ where: { workspaceId: session.workspaceId, folderId: { in: tree }, deletedAt: null }, select: { userId: true } });
  if (session.role !== "owner") {
    const foreignFolder = all.some((folder) => tree.includes(folder.id) && folder.createdByUserId !== session.userId);
    const foreignNote = notes.some((note) => note.userId !== session.userId);
    if (foreignFolder || foreignNote) return fail("This folder has items other people added. Ask a workspace owner to delete it.");
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.folder.updateMany({ where: { id: { in: tree }, workspaceId: session.workspaceId, deletedAt: null }, data: { deletedAt: now, trashRootId: id } });
    await tx.meeting.updateMany({ where: { workspaceId: session.workspaceId, folderId: { in: tree }, deletedAt: null }, data: { deletedAt: now, trashRootId: id } });
  });
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "folder.trash", targetType: "folder", targetId: id, metadata: { folders: tree.length, notes: notes.length } });
  return { ok: true, folders: tree.length, notes: notes.length };
}

export type TrashKind = "folder" | "note";

export interface TrashItem {
  kind: TrashKind;
  id: string;
  name: string;
  deletedAt: Date;
  daysLeft: number;
  /** For folders: what went with it. */
  noteCount: number;
  folderCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

interface TrashRootRow {
  id: string;
  name: string;
  deletedAt: Date;
}

/** Items the user deleted directly (not the contents that went with a folder), newest first. */
export async function listTrash(workspaceId: string, now = new Date()): Promise<TrashItem[]> {
  const [folders, notes] = await Promise.all([
    prisma.$queryRaw<TrashRootRow[]>`SELECT "id", "name", "deletedAt" FROM "Folder" WHERE "workspaceId" = ${workspaceId} AND "deletedAt" IS NOT NULL AND "trashRootId" = "id" ORDER BY "deletedAt" DESC LIMIT 500`,
    prisma.$queryRaw<TrashRootRow[]>`SELECT "id", "title" AS "name", "deletedAt" FROM "Meeting" WHERE "workspaceId" = ${workspaceId} AND "deletedAt" IS NOT NULL AND "trashRootId" = "id" ORDER BY "deletedAt" DESC LIMIT 500`,
  ]);
  const withFolders = await Promise.all(folders.map(async (folder) => {
    const [noteCount, folderCount] = await Promise.all([
      prisma.meeting.count({ where: { workspaceId, trashRootId: folder.id } }),
      prisma.folder.count({ where: { workspaceId, trashRootId: folder.id } }),
    ]);
    return { folder, noteCount, folderCount };
  }));
  const daysLeft = (deletedAt: Date) => Math.max(0, Math.ceil((deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS - now.getTime()) / DAY_MS));
  return [
    ...withFolders.map(({ folder, noteCount, folderCount }): TrashItem => ({ kind: "folder", id: folder.id, name: folder.name, deletedAt: folder.deletedAt, daysLeft: daysLeft(folder.deletedAt), noteCount, folderCount })),
    ...notes.map((note): TrashItem => ({ kind: "note", id: note.id, name: note.name, deletedAt: note.deletedAt, daysLeft: daysLeft(note.deletedAt), noteCount: 0, folderCount: 0 })),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}

/** Free name among a folder's live siblings: "Plans", then "Plans (restored)", "Plans (restored 2)", ... */
async function freeFolderName(workspaceId: string, parentId: string | null, name: string): Promise<string> {
  const siblings = await prisma.folder.findMany({ where: { workspaceId, parentId, deletedAt: null }, select: { name: true } });
  const taken = new Set(siblings.map((sibling) => sibling.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let attempt = 1; attempt < 50; attempt += 1) {
    const candidate = `${name} (restored${attempt > 1 ? ` ${attempt}` : ""})`.slice(0, 80);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, 60)} (${randomUUID().slice(0, 8)})`;
}

export async function restoreFromTrash(session: LibrarySession, kind: TrashKind, id: string): Promise<{ ok: true } | Fail> {
  if (kind === "note") {
    const note = await prisma.meeting.findFirst({ where: { id, workspaceId: session.workspaceId, deletedAt: { not: null }, trashRootId: id }, select: { folderId: true } });
    if (!note) return fail("That note isn't in the trash.");
    const folderLive = note.folderId ? Boolean(await prisma.folder.findFirst({ where: { id: note.folderId, workspaceId: session.workspaceId, deletedAt: null }, select: { id: true } })) : true;
    await prisma.meeting.updateMany({ where: { id, workspaceId: session.workspaceId, deletedAt: { not: null } }, data: { deletedAt: null, trashRootId: null, ...(folderLive ? {} : { folderId: null }) } });
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "meeting.restore", targetType: "meeting", targetId: id });
    return { ok: true };
  }
  const folder = await prisma.folder.findFirst({ where: { id, workspaceId: session.workspaceId, deletedAt: { not: null }, trashRootId: id }, select: { parentId: true, name: true } });
  if (!folder) return fail("That folder isn't in the trash.");
  const parentLive = folder.parentId ? Boolean(await prisma.folder.findFirst({ where: { id: folder.parentId, workspaceId: session.workspaceId, deletedAt: null }, select: { id: true } })) : true;
  const parentId = parentLive ? folder.parentId : null;
  const name = await freeFolderName(session.workspaceId, parentId, folder.name);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.folder.updateMany({ where: { id, workspaceId: session.workspaceId }, data: { deletedAt: null, trashRootId: null, parentId, name } });
      await tx.folder.updateMany({ where: { workspaceId: session.workspaceId, trashRootId: id, deletedAt: { not: null } }, data: { deletedAt: null, trashRootId: null } });
      await tx.meeting.updateMany({ where: { workspaceId: session.workspaceId, trashRootId: id, deletedAt: { not: null } }, data: { deletedAt: null, trashRootId: null } });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("Couldn't restore that folder because its name is now taken. Try again.");
    throw error;
  }
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "folder.restore", targetType: "folder", targetId: id });
  return { ok: true };
}

/** Permanently deletes one trashed root and everything that went with it. */
async function purgeRoot(workspaceId: string, kind: TrashKind, id: string): Promise<number> {
  if (kind === "note") {
    await deleteMeeting(workspaceId, id);
    return 1;
  }
  const notes = await prisma.meeting.findMany({ where: { workspaceId, trashRootId: id, deletedAt: { not: null } }, select: { id: true } });
  for (const note of notes) await deleteMeeting(workspaceId, note.id);
  // Subfolders go with the root through the parent foreign key.
  await prisma.folder.deleteMany({ where: { id, workspaceId, deletedAt: { not: null } } });
  return notes.length + 1;
}

export async function deleteForever(session: LibrarySession, kind: TrashKind, id: string): Promise<{ ok: true } | Fail> {
  if (kind === "note") {
    const note = await prisma.meeting.findFirst({ where: { id, workspaceId: session.workspaceId, deletedAt: { not: null }, trashRootId: id }, select: { userId: true } });
    if (!note) return fail("That note isn't in the trash.");
    if (!canTrashNote(session, note.userId)) return fail("Only the person who wrote this note, or a workspace owner, can delete it forever.");
  } else {
    const folder = await prisma.folder.findFirst({ where: { id, workspaceId: session.workspaceId, deletedAt: { not: null }, trashRootId: id }, select: { createdByUserId: true } });
    if (!folder) return fail("That folder isn't in the trash.");
    if (session.role !== "owner") {
      const foreign = await prisma.meeting.count({ where: { workspaceId: session.workspaceId, trashRootId: id, userId: { not: session.userId } } });
      const foreignFolders = await prisma.folder.count({ where: { workspaceId: session.workspaceId, trashRootId: id, OR: [{ createdByUserId: { not: session.userId } }, { createdByUserId: null }] } });
      if (foreign > 0 || foreignFolders > 0) return fail("This folder has items other people added. Ask a workspace owner to delete it forever.");
    }
  }
  await purgeRoot(session.workspaceId, kind, id);
  await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: kind === "folder" ? "folder.purge" : "meeting.purge", targetType: kind === "folder" ? "folder" : "meeting", targetId: id });
  return { ok: true };
}

export async function emptyTrash(session: LibrarySession): Promise<{ ok: true; removed: number } | Fail> {
  if (session.role !== "owner") return fail("Only a workspace owner can empty the trash.");
  const items = await listTrash(session.workspaceId);
  for (const item of items) await purgeRoot(session.workspaceId, item.kind, item.id);
  if (items.length > 0) {
    await recordAudit({ workspaceId: session.workspaceId, actorUserId: session.userId, action: "trash.empty", targetType: "workspace", targetId: session.workspaceId, metadata: { items: items.length } });
  }
  return { ok: true, removed: items.length };
}

const PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const PURGE_BATCH = 50;
let lastPurgeAt = 0;

/**
 * Permanently removes items that have sat in Trash past the retention window.
 * Throttled to once an hour per process so the managed worker's poll, and a
 * self-hosted instance's page loads, can both call it freely.
 */
export async function purgeExpiredTrash(now = new Date(), force = false): Promise<number> {
  if (!force && now.getTime() - lastPurgeAt < PURGE_INTERVAL_MS) return 0;
  lastPurgeAt = now.getTime();
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const [folders, notes] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; workspaceId: string }>>`SELECT "id", "workspaceId" FROM "Folder" WHERE "deletedAt" < ${cutoff} AND "trashRootId" = "id" LIMIT ${PURGE_BATCH}`,
    prisma.$queryRaw<Array<{ id: string; workspaceId: string | null }>>`SELECT "id", "workspaceId" FROM "Meeting" WHERE "deletedAt" < ${cutoff} AND "trashRootId" = "id" AND "workspaceId" IS NOT NULL LIMIT ${PURGE_BATCH}`,
  ]);
  const perWorkspace = new Map<string, number>();
  let removed = 0;
  for (const folder of folders) {
    await purgeRoot(folder.workspaceId, "folder", folder.id);
    perWorkspace.set(folder.workspaceId, (perWorkspace.get(folder.workspaceId) ?? 0) + 1);
    removed += 1;
  }
  for (const note of notes) {
    if (!note.workspaceId) continue;
    await purgeRoot(note.workspaceId, "note", note.id);
    perWorkspace.set(note.workspaceId, (perWorkspace.get(note.workspaceId) ?? 0) + 1);
    removed += 1;
  }
  for (const [workspaceId, items] of perWorkspace) {
    await recordAudit({ workspaceId, action: "trash.purge", targetType: "workspace", targetId: workspaceId, metadata: { items, retentionDays: TRASH_RETENTION_DAYS } });
  }
  return removed;
}
