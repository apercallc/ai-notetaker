import { prisma } from "./db";
import type { RecordingChunk } from "./recordingStream";

export type RecordingChannel = "mic" | "speaker";

export interface MeetingRecording {
  title: string;
  chunks: RecordingChunk[];
  totalBytes: number;
}

/**
 * Chunk metadata for one channel of a meeting's newest completed upload,
 * scoped to the caller's workspace. No audio is read here — the recording
 * route streams the objects lazily so it can honour Range requests. (The
 * billing-side `openManagedRecording` streams the whole channel front to
 * back; seeking in a player needs per-chunk sizes to skip ahead.)
 */
export async function findMeetingRecording(
  workspaceId: string,
  meetingId: string,
  channel: RecordingChannel,
): Promise<MeetingRecording | null> {
  const upload = await prisma.managedUpload.findFirst({
    where: { workspaceId, meetingId, status: "complete" },
    orderBy: { createdAt: "desc" },
    include: {
      meeting: { select: { title: true } },
      chunks: { where: { channel }, orderBy: { chunkIndex: "asc" }, select: { objectKey: true, byteLength: true } },
    },
  });
  if (!upload || upload.chunks.length === 0) return null;
  return {
    title: upload.meeting.title,
    chunks: upload.chunks,
    totalBytes: upload.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  };
}
