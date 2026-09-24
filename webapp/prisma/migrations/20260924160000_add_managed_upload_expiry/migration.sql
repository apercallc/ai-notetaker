-- Abandoned resumable sessions must not remain writable forever.
ALTER TABLE "ManagedUpload" ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "ManagedUpload"
SET "expiresAt" = COALESCE("completedAt", "createdAt" + INTERVAL '24 hours');

ALTER TABLE "ManagedUpload" ALTER COLUMN "expiresAt" SET NOT NULL;
