-- Global worker polls cannot use the workspace-leading status index to narrow
-- queued/stalled candidates. Expiry cleanup also scans across all workspaces.
CREATE INDEX "ProcessingJob_status_createdAt_idx" ON "ProcessingJob"("status", "createdAt");
CREATE INDEX "ProcessingJob_status_startedAt_attempts_idx" ON "ProcessingJob"("status", "startedAt", "attempts");
CREATE INDEX "ManagedUpload_expiresAt_id_idx" ON "ManagedUpload"("expiresAt", "id");
