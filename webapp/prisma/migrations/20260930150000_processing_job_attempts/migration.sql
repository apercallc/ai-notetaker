-- Bound how many times a crashed or stalled job can be reclaimed, so a poison
-- recording cannot burn provider spend forever.
ALTER TABLE "ProcessingJob" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
