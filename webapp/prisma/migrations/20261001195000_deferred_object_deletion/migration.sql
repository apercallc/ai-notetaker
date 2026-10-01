CREATE TABLE "DeferredObjectDeletion" (
  "id" TEXT NOT NULL PRIMARY KEY, "backendId" TEXT NOT NULL, "objectKey" TEXT NOT NULL,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeferredObjectDeletion_backendId_nextAttemptAt_idx" ON "DeferredObjectDeletion"("backendId", "nextAttemptAt");
