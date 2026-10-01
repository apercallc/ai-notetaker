-- Multilingual notes: workspace vocabulary and summary language, per-meeting spoken language.
ALTER TABLE "Workspace" ADD COLUMN "vocabulary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Workspace" ADD COLUMN "summaryLanguage" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "language" TEXT;
