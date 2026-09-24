import { requireSession } from "@/lib/currentUser";
import { readManagedRecording, type ManagedRecordingChannel } from "@/lib/managedJobs";

const SAMPLE_RATE_HZ = 48_000;
const BYTES_PER_SAMPLE = 2;

function wavBytes(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const result = new Uint8Array(44 + pcm.byteLength);
  result.set(new Uint8Array(header), 0);
  result.set(pcm, 44);
  return result;
}

function safeFilename(title: string, channel: ManagedRecordingChannel): string {
  const base = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "meeting";
  return `${base}-${channel}.wav`;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { workspaceId } = await requireSession();
  const { id } = await params;
  const channel = new URL(request.url).searchParams.get("channel");
  if (channel !== "mic" && channel !== "speaker") return new Response("invalid channel", { status: 400 });
  const recording = await readManagedRecording(workspaceId, id, channel);
  if (!recording) return new Response("recording not found", { status: 404 });
  return new Response(wavBytes(recording.bytes) as BodyInit, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="${safeFilename(recording.title, channel)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
