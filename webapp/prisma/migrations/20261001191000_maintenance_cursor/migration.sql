CREATE TABLE "MaintenanceCursor" (
  "id" TEXT NOT NULL PRIMARY KEY, "value" TEXT,
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL
);
