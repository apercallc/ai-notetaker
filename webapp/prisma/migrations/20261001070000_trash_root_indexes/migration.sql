-- Trash listing counts the contents of each trashed folder by trashRootId; purge scans for expired roots.
CREATE INDEX "Meeting_workspaceId_trashRootId_idx" ON "Meeting"("workspaceId", "trashRootId");
CREATE INDEX "Folder_workspaceId_trashRootId_idx" ON "Folder"("workspaceId", "trashRootId");
CREATE INDEX "Meeting_expired_trash_roots_idx" ON "Meeting"("deletedAt") WHERE "trashRootId" = "id";
CREATE INDEX "Folder_expired_trash_roots_idx" ON "Folder"("deletedAt") WHERE "trashRootId" = "id";
