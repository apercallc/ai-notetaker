-- Accounts an owner created by typing an email address and choosing a
-- password. The mailbox was never proven by its holder, so Google sign-in must
-- not treat the matching address as this account's owner.
ALTER TABLE "User" ADD COLUMN "ownerProvisioned" BOOLEAN NOT NULL DEFAULT false;
-- Owner-created accounts are the only ones that are email-verified yet never
-- accepted the terms (self-service, invite and Google accounts all record
-- consent). This also covers the self-hosted bootstrap owner, who signs in
-- with a password, and any pre-consent legacy account: refusing Google
-- sign-in for those is the safe direction.
UPDATE "User" SET "ownerProvisioned" = true WHERE "emailVerifiedAt" IS NOT NULL AND "termsAcceptedAt" IS NULL;
