-- Library: nested folders, notes placed in folders, trash with restore, and
-- hand-edited note bodies with one level of undo. All additive.
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "trashRootId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Folder_workspaceId_parentId_idx" ON "Folder"("workspaceId", "parentId");
CREATE INDEX "Folder_workspaceId_deletedAt_idx" ON "Folder"("workspaceId", "deletedAt");

-- One live folder name per parent, ignoring case. The top level uses an empty
-- string for its parent so it is covered too.
CREATE UNIQUE INDEX "Folder_live_name_key" ON "Folder" ("workspaceId", COALESCE("parentId", ''), lower("name")) WHERE "deletedAt" IS NULL;

ALTER TABLE "Folder" ADD CONSTRAINT "Folder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Meeting" ADD COLUMN "folderId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "trashRootId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "summaryEditedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "previousSummary" TEXT;

CREATE INDEX "Meeting_workspaceId_folderId_startedAt_idx" ON "Meeting"("workspaceId", "folderId", "startedAt");
CREATE INDEX "Meeting_workspaceId_deletedAt_idx" ON "Meeting"("workspaceId", "deletedAt");

ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
