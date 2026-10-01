-- Per-meeting speaker names (transcript keys stay stable).
CREATE TABLE "MeetingSpeaker" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "speakerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "appliedLabel" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingSpeaker_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MeetingSpeaker_meetingId_speakerKey_key" ON "MeetingSpeaker"("meetingId", "speakerKey");

ALTER TABLE "MeetingSpeaker" ADD CONSTRAINT "MeetingSpeaker_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
