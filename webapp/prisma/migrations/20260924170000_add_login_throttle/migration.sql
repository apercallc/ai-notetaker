-- Keep failed-login budgets shared across managed web replicas and deploys.
CREATE TABLE "LoginThrottle" (
    "emailKey" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("emailKey")
);

CREATE INDEX "LoginThrottle_firstFailureAt_idx" ON "LoginThrottle"("firstFailureAt");
