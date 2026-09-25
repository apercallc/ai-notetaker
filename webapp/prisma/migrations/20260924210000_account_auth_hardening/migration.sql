-- Account/auth hardening: email normalization, verification, forced password
-- change, hashed API tokens, session metadata and single-use auth tokens.

-- 1. New columns. Existing accounts are grandfathered as verified: they were
--    created before verification existed and locking them out would be a
--    regression.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "termsVersion" TEXT;
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

ALTER TABLE "Session" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "Session" ADD COLUMN "ip" TEXT;
ALTER TABLE "Session" ADD COLUMN "activeWorkspaceId" TEXT;

-- 2. Lowercase + trim existing emails. When two accounts collapse to the same
--    address the OLDEST keeps it (it is the one whose owner most plausibly
--    holds the mailbox and whose history is longest). Each later duplicate is
--    moved aside to "<local>+dup-<id8>@<domain>" rather than deleted, so no
--    user, session or meeting data is lost; the move is reported with a
--    NOTICE so an operator can contact those users.
DO $$
DECLARE
  rec RECORD;
  local_part TEXT;
  domain_part TEXT;
BEGIN
  FOR rec IN
    SELECT "id", lower(btrim("email")) AS normalized,
           row_number() OVER (PARTITION BY lower(btrim("email")) ORDER BY "createdAt", "id") AS rn
    FROM "User"
  LOOP
    IF rec.rn = 1 THEN
      IF (SELECT "email" FROM "User" WHERE "id" = rec."id") <> rec.normalized THEN
        UPDATE "User" SET "email" = rec.normalized WHERE "id" = rec."id";
      END IF;
    ELSE
      local_part := split_part(rec.normalized, '@', 1);
      domain_part := substr(rec.normalized, length(local_part) + 2);
      UPDATE "User"
        SET "email" = local_part || '+dup-' || substr(rec."id", 1, 8) || '@' || CASE WHEN domain_part = '' THEN 'invalid.local' ELSE domain_part END
        WHERE "id" = rec."id";
      RAISE NOTICE 'email collision: user % moved aside from % (kept by older account)', rec."id", rec.normalized;
    END IF;
  END LOOP;
END $$;

-- 3. Case-insensitive uniqueness, enforced by the database even for writers
--    that bypass the application's normalization.
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));

-- 4. Hashed extension / managed-client API tokens.
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'managed',
    "label" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");
CREATE INDEX "ApiToken_expiresAt_idx" ON "ApiToken"("expiresAt");
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Single-use verification / reset / invite tokens.
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "workspaceId" TEXT,
    "role" TEXT,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");
CREATE INDEX "AuthToken_userId_purpose_idx" ON "AuthToken"("userId", "purpose");
CREATE INDEX "AuthToken_workspaceId_purpose_idx" ON "AuthToken"("workspaceId", "purpose");
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Deterministic ordering for "default workspace" lookups.
CREATE INDEX "WorkspaceMembership_userId_createdAt_idx" ON "WorkspaceMembership"("userId", "createdAt");
