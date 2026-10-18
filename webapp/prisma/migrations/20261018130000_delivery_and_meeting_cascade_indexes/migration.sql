-- The account page lists a workspace's recent deliveries, newest first.
CREATE INDEX "IntegrationDelivery_workspaceId_createdAt_idx" ON "IntegrationDelivery"("workspaceId", "createdAt");

-- Deleting a meeting cascades to uploads and share links by meetingId alone,
-- which the existing (workspaceId, meetingId) indexes cannot serve.
CREATE INDEX "ManagedUpload_meetingId_idx" ON "ManagedUpload"("meetingId");
CREATE INDEX "MeetingShareToken_meetingId_idx" ON "MeetingShareToken"("meetingId");
