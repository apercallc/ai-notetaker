import { requireSession } from "@/lib/currentUser";
import { findMeetingRecording, type RecordingChannel } from "@/lib/meetingRecording";
import { getObject } from "@/lib/objectStorage";
import { parseRange, recordingStream, wavHeader, WAV_HEADER_BYTES } from "@/lib/recordingStream";

function safeFilename(title: string, channel: RecordingChannel): string {
  const base = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "meeting";
  return `${base}-${channel}.wav`;
}

/**
 * Streams one channel of a meeting's recording as WAV. Inline by default so
 * the detail page's <audio> element can play and seek it; `?download=1`
 * forces a file download. Chunks are read one at a time — memory stays at a
 * single chunk however long the meeting was — and HTTP Range is supported so
 * scrubbing doesn't re-download from the start.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { workspaceId } = await requireSession();
  const { id } = await params;
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  if (channel !== "mic" && channel !== "speaker") return new Response("invalid channel", { status: 400 });

  const recording = await findMeetingRecording(workspaceId, id, channel);
  if (!recording) return new Response("recording not found", { status: 404 });

  const size = WAV_HEADER_BYTES + recording.totalBytes;
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  const baseHeaders: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Content-Disposition": `${disposition}; filename="${safeFilename(recording.title, channel)}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };

  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
  }

  const window = range ?? { start: 0, end: size - 1 };
  const body = recordingStream(wavHeader(recording.totalBytes), recording.chunks, window, getObject);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(window.end - window.start + 1),
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    },
  });
}
