CREATE TABLE "GoogleExtensionAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleExtensionAuthCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleExtensionAuthCode_codeHash_key" ON "GoogleExtensionAuthCode"("codeHash");
CREATE INDEX "GoogleExtensionAuthCode_expiresAt_idx" ON "GoogleExtensionAuthCode"("expiresAt");
CREATE INDEX "GoogleExtensionAuthCode_userId_idx" ON "GoogleExtensionAuthCode"("userId");

ALTER TABLE "GoogleExtensionAuthCode" ADD CONSTRAINT "GoogleExtensionAuthCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleExtensionAuthCode" ADD CONSTRAINT "GoogleExtensionAuthCode_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
