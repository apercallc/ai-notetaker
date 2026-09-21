-- Additive fields keep existing self-hosted meeting rows readable.
ALTER TABLE "Meeting" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "ActionItem" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "ActionItem" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "ActionItem" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "ActionItem_userId_status_dueAt_idx" ON "ActionItem"("userId", "status", "dueAt");
