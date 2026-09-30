-- Accounts an owner created by typing an email address and choosing a
-- password. The mailbox was never proven by its holder, so Google sign-in must
-- not treat the matching address as this account's owner.
ALTER TABLE "User" ADD COLUMN "ownerProvisioned" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "ownerProvisioned" = true WHERE "mustChangePassword" = true;
