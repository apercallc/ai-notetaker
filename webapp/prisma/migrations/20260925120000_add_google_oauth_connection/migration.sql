-- Project-owned Google OAuth connection. OAuth credentials belong to an
-- individual account, never to a workspace; every token field is encrypted by
-- the application before it reaches this table.
CREATE TABLE "GoogleOAuthConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountEmail" TEXT,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleOAuthConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleOAuthConnection_userId_key" ON "GoogleOAuthConnection"("userId");
CREATE INDEX "GoogleOAuthConnection_expiresAt_idx" ON "GoogleOAuthConnection"("expiresAt");
ALTER TABLE "GoogleOAuthConnection" ADD CONSTRAINT "GoogleOAuthConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
