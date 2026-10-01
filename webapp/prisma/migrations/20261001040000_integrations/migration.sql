-- Outbound "note ready" integrations (signed webhook, Slack, Notion) and their deliveries.
ALTER TABLE "Meeting" ADD COLUMN "readyNotifiedAt" TIMESTAMP(3);

CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configCipher" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationDelivery" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "meetingId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "responseStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Integration_workspaceId_idx" ON "Integration"("workspaceId");
CREATE INDEX "IntegrationDelivery_status_nextAttemptAt_idx" ON "IntegrationDelivery"("status", "nextAttemptAt");
CREATE INDEX "IntegrationDelivery_integrationId_createdAt_idx" ON "IntegrationDelivery"("integrationId", "createdAt");
CREATE INDEX "IntegrationDelivery_createdAt_idx" ON "IntegrationDelivery"("createdAt");

ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
