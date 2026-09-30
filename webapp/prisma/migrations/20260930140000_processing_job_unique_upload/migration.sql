-- One processing job per upload. A second job for the same audio would reserve
-- a second unit and, once the staged audio is purged after the first success,
-- overwrite the real transcript with an empty one. Keep the earliest job per
-- upload before enforcing it.
DELETE FROM "ProcessingJob" a
USING "ProcessingJob" b
WHERE a."uploadId" = b."uploadId"
  AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

CREATE UNIQUE INDEX "ProcessingJob_uploadId_key" ON "ProcessingJob"("uploadId");
