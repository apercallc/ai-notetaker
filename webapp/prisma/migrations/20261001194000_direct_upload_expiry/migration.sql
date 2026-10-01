ALTER TABLE "UploadChunk" ADD COLUMN "signedUntil" TIMESTAMP(3);
ALTER TABLE "DirectUploadTicket" ADD COLUMN "signedUntil" TIMESTAMP(3);
