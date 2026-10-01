CREATE TABLE "ProviderSpendBucket" (
  "id" TEXT NOT NULL PRIMARY KEY, "day" TEXT NOT NULL,
  "committedMicros" BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX "ProviderSpendBucket_day_idx" ON "ProviderSpendBucket"("day");
CREATE TABLE "ProviderSpendAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL, "provider" TEXT NOT NULL, "day" TEXT NOT NULL,
  "reservedMicros" BIGINT NOT NULL, "chargedMicros" BIGINT NOT NULL,
  "bucketIds" TEXT[] NOT NULL, "status" TEXT NOT NULL DEFAULT 'reserved',
  "httpStatus" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3)
);
CREATE INDEX "ProviderSpendAttempt_workspaceId_createdAt_idx" ON "ProviderSpendAttempt"("workspaceId", "createdAt");
CREATE INDEX "ProviderSpendAttempt_day_provider_idx" ON "ProviderSpendAttempt"("day", "provider");
