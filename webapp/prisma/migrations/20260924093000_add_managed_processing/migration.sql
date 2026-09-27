ALTER TABLE "Meeting"
  ADD COLUMN "captureSource" TEXT NOT NULL DEFAULT 'desktop',
  ADD COLUMN "processingMode" TEXT NOT NULL DEFAULT 'local_byok',
  ADD COLUMN "recordingObjectKey" TEXT;

CREATE TABLE "ManagedUpload" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "totalChunks" INTEGER NOT NULL,
  "totalBytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "objectKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ManagedUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManagedUpload_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ManagedUpload_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManagedUpload_workspaceId_idempotencyKey_key" ON "ManagedUpload"("workspaceId", "idempotencyKey");
CREATE INDEX "ManagedUpload_workspaceId_meetingId_idx" ON "ManagedUpload"("workspaceId", "meetingId");

CREATE TABLE "UploadChunk" (
  "id" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'speaker',
  "byteLength" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UploadChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UploadChunk_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "ManagedUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UploadChunk_uploadId_chunkIndex_key" ON "UploadChunk"("uploadId", "chunkIndex");

CREATE TABLE "ProcessingJob" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "errorMessage" TEXT,
  "providerCostMicros" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProcessingJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProcessingJob_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProcessingJob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "ManagedUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProcessingJob_workspaceId_idempotencyKey_key" ON "ProcessingJob"("workspaceId", "idempotencyKey");
CREATE INDEX "ProcessingJob_workspaceId_status_createdAt_idx" ON "ProcessingJob"("workspaceId", "status", "createdAt");

CREATE TABLE "UsageLedgerEntry" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "kind" TEXT NOT NULL,
  "units" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLedgerEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UsageLedgerEntry_workspaceId_idempotencyKey_key" ON "UsageLedgerEntry"("workspaceId", "idempotencyKey");
CREATE INDEX "UsageLedgerEntry_workspaceId_periodStart_kind_idx" ON "UsageLedgerEntry"("workspaceId", "periodStart", "kind");

CREATE TABLE "WorkspaceSubscription" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "plan" TEXT NOT NULL DEFAULT 'local',
  "status" TEXT NOT NULL DEFAULT 'inactive',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "graceEndsAt" TIMESTAMP(3),
  "lastBillingEventCreatedAt" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceSubscription_workspaceId_key" ON "WorkspaceSubscription"("workspaceId");
CREATE UNIQUE INDEX "WorkspaceSubscription_stripeCustomerId_key" ON "WorkspaceSubscription"("stripeCustomerId");
CREATE UNIQUE INDEX "WorkspaceSubscription_stripeSubscriptionId_key" ON "WorkspaceSubscription"("stripeSubscriptionId");

CREATE TABLE "MeetingShareToken" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "meetingId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MeetingShareToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MeetingShareToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MeetingShareToken_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MeetingShareToken_tokenHash_key" ON "MeetingShareToken"("tokenHash");
CREATE INDEX "MeetingShareToken_workspaceId_meetingId_idx" ON "MeetingShareToken"("workspaceId", "meetingId");

CREATE TABLE "BillingEvent" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "eventCreatedAt" INTEGER,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);
