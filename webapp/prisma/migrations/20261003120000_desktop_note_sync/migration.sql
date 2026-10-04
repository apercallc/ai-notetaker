-- Additive desktop notes-sync credential scope. Existing extension/managed
-- tokens remain workspace-unbound and keep their prior behavior.
ALTER TABLE "ApiToken" ADD COLUMN "workspaceId" TEXT;
CREATE INDEX "ApiToken_workspaceId_idx" ON "ApiToken"("workspaceId");
ALTER TABLE "ApiToken"
  ADD CONSTRAINT "ApiToken_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Desktop BYOK transcription providers do not all return word/segment timing.
-- Preserve transcript order without fabricating timestamps for those segments.
ALTER TABLE "TranscriptSegment" ALTER COLUMN "timestamp" DROP NOT NULL;
