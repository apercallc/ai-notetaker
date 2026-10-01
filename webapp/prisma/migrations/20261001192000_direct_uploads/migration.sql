CREATE TABLE "DirectUploadTicket" (
  "id" TEXT NOT NULL PRIMARY KEY, "uploadId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL, "channel" TEXT NOT NULL,
  "byteLength" INTEGER NOT NULL, "checksum" TEXT NOT NULL, "objectKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DirectUploadTicket_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "ManagedUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DirectUploadTicket_uploadId_chunkIndex_key" ON "DirectUploadTicket"("uploadId", "chunkIndex");
