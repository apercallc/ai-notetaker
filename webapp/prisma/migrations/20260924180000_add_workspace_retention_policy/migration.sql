-- Managed workspaces may opt into asynchronous meeting and object retention cleanup.
ALTER TABLE "Workspace" ADD COLUMN "retentionDays" INTEGER;
