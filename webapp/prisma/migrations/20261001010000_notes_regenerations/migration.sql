-- Bounds how often hosted notes can be regenerated from the stored transcript.
ALTER TABLE "Meeting" ADD COLUMN "notesRegenerations" INTEGER NOT NULL DEFAULT 0;
