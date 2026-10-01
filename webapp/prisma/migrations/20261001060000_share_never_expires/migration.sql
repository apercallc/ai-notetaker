-- Share links may be created without an expiry (NULL = never expires; revoke or delete the note to end it).
ALTER TABLE "MeetingShareToken" ALTER COLUMN "expiresAt" DROP NOT NULL;
