-- File import: one user-supplied audio/video file per upload, decoded by the
-- worker. Existing rows are live captures and keep their behavior.
ALTER TABLE "ManagedUpload" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'capture';
ALTER TABLE "ManagedUpload" ADD COLUMN "sourceFormat" TEXT;
ALTER TABLE "ManagedUpload" ADD COLUMN "declaredDurationSeconds" INTEGER;
ALTER TABLE "ProcessingJob" ADD COLUMN "stage" TEXT;
