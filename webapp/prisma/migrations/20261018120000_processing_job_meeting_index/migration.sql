-- The latest-job lookup on every library and note page filters by meetingId.
CREATE INDEX "ProcessingJob_meetingId_createdAt_idx" ON "ProcessingJob"("meetingId", "createdAt");
