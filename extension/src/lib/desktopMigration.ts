import type { MeetingRecord, NotetakerSettings } from "../types";
import { browserMeetArchiveInventory, streamBrowserMeetChunks } from "../meet/browserStorage";

export const DESKTOP_MIGRATION_VERSION = 1;
const MAX_DESKTOP_MIGRATION_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_ARCHIVE_BYTES = 50 * 1024 * 1024 * 1024;
const AUDIO_ARCHIVE_MAGIC = new TextEncoder().encode("NTKAR001");
const MAX_ARCHIVE_CHUNK_BYTES = 8 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

type ArchiveWriter = Pick<FileSystemWritableFileStream, "write" | "close" | "abort">;
type SavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable: () => Promise<ArchiveWriter> }>;

export interface DesktopMigrationArchive {
  format: "ai-notetaker-desktop-transfer";
  version: typeof DESKTOP_MIGRATION_VERSION;
  exportedAt: string;
  settings: {
    transcriptionProvider: NotetakerSettings["transcriptionProvider"];
    summarizationProvider: NotetakerSettings["summarizationProvider"];
    defaultMeetingMode: NotetakerSettings["defaultMeetingMode"];
    customVocabulary: string[];
    customSummaryInstructions: string;
  };
  meetings: Array<{
    id: string;
    title: string;
    startedAt: string;
    endedAt: string | null;
    mode: MeetingRecord["mode"];
    status: MeetingRecord["status"];
    transcript: Array<Pick<MeetingRecord["transcript"][number], "speaker" | "text" | "timestamp" | "isFinal">>;
    summary: string | null;
    actionItems: Array<Pick<MeetingRecord["actionItems"][number], "text" | "owner" | "id" | "status" | "dueAt" | "completedAt">>;
  }>;
}

/** Whitelist only portable preferences and note text. Never serialize credentials or audio. */
export function createDesktopMigrationArchive(
  settings: NotetakerSettings,
  meetings: MeetingRecord[],
  exportedAt: string = new Date().toISOString(),
): DesktopMigrationArchive {
  return {
    format: "ai-notetaker-desktop-transfer",
    version: DESKTOP_MIGRATION_VERSION,
    exportedAt,
    settings: {
      transcriptionProvider: settings.transcriptionProvider,
      summarizationProvider: settings.summarizationProvider,
      defaultMeetingMode: settings.defaultMeetingMode,
      customVocabulary: settings.customVocabulary.slice(0, 100),
      customSummaryInstructions: settings.customSummaryInstructions.slice(0, 4_000),
    },
    meetings: meetings
      .map(({ id, title, startedAt, endedAt, mode, status, transcript, summary, actionItems }) => ({
        id,
        title,
        startedAt,
        endedAt,
        mode,
        status,
        transcript: transcript.map(({ speaker, text, timestamp, isFinal }) => ({ speaker, text, timestamp, isFinal })),
        summary,
        actionItems: actionItems.map(({ text, owner, id, status, dueAt, completedAt }) => ({ text, owner, id, status, dueAt, completedAt })),
      })),
  };
}

export function downloadDesktopMigrationArchive(archive: DesktopMigrationArchive): void {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  if (blob.size > MAX_DESKTOP_MIGRATION_BYTES) {
    throw new Error("This transfer file exceeds the desktop app’s 20 MB import limit. Export fewer meetings first.");
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-notetaker-desktop-transfer-${archive.exportedAt.slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Writes one portable archive without collecting raw audio in memory. The
 * save picker opens synchronously from the Settings click; audio is then
 * streamed from IndexedDB in bounded batches.
 */
export async function saveDesktopAudioArchive(
  settings: NotetakerSettings,
  loadMeetings: () => Promise<MeetingRecord[]>,
  exportedAt: string = new Date().toISOString(),
): Promise<{ meetingCount: number; chunkCount: number; audioBytes: number }> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) throw new Error("This Chrome version cannot stream a full audio archive. Export notes only instead.");
  const handle = await picker({
    suggestedName: `ai-notetaker-desktop-transfer-${exportedAt.slice(0, 10)}.ntarchive`,
    types: [{ description: "AI Notetaker transfer archive", accept: { "application/octet-stream": [".ntarchive"] } }],
  });
  const writer = await handle.createWritable();
  try {
    const [storedMeetings, inventory] = await Promise.all([loadMeetings(), browserMeetArchiveInventory()]);
    const totalAudioBytes = inventory.reduce((total, item) => total + item.totalBytes, 0);
    if (!Number.isSafeInteger(totalAudioBytes) || totalAudioBytes > MAX_AUDIO_ARCHIVE_BYTES) {
      throw new Error("Saved audio exceeds the desktop app’s 50 GB archive limit. Your extension data is unchanged.");
    }
    if (inventory.some((item) => item.chunkCount <= 0 || item.lastSequence < 0)) {
      throw new Error("A saved audio record has invalid sequence data. Your extension data is unchanged.");
    }
    const meetingById = new Map(storedMeetings.map((meeting) => [meeting.id, meeting]));
    for (const audio of inventory) {
      if (!meetingById.has(audio.meetingId)) {
        const firstDate = audio.firstCapturedAt === null ? null : new Date(audio.firstCapturedAt);
        const startedAt = firstDate && !Number.isNaN(firstDate.getTime()) ? firstDate.toISOString() : exportedAt;
        meetingById.set(audio.meetingId, {
          id: audio.meetingId,
          title: "Recovered Google Meet audio",
          startedAt,
          endedAt: null,
          transcript: [],
          summary: null,
          actionItems: [],
          status: "error",
          captureSource: "meet",
        });
      }
    }
    const meetings = [...meetingById.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const notes = createDesktopMigrationArchive(settings, meetings, exportedAt);
    const manifest = JSON.stringify({
      format: "ai-notetaker-desktop-audio-transfer",
      version: 1,
      sampleRateHz: 48_000,
      notes,
      audioMeetingIds: inventory.map(({ meetingId }) => meetingId),
    });
    const manifestBytes = new TextEncoder().encode(manifest);
    if (manifestBytes.length > MAX_DESKTOP_MIGRATION_BYTES) {
      throw new Error("Meeting text exceeds the 20 MB transfer limit. Export fewer meetings first.");
    }

    const header = new Uint8Array(AUDIO_ARCHIVE_MAGIC.length + 4);
    header.set(AUDIO_ARCHIVE_MAGIC);
    new DataView(header.buffer).setUint32(AUDIO_ARCHIVE_MAGIC.length, manifestBytes.length, true);
    await writer.write(header);
    await writer.write(manifestBytes);

    let chunkCount = 0;
    let audioBytes = 0;
    const encoder = new TextEncoder();
    for (const { meetingId, lastSequence } of inventory) {
      const idBytes = encoder.encode(meetingId);
      if (idBytes.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId)) {
        throw new Error("A saved audio record has an invalid meeting id. Its source data was left unchanged.");
      }
      for await (const chunk of streamBrowserMeetChunks(meetingId, undefined, lastSequence)) {
        if (chunk.bytes.length === 0 || chunk.bytes.length > MAX_ARCHIVE_CHUNK_BYTES || chunk.bytes.length % 2 !== 0) {
          throw new Error("A saved audio chunk is invalid or too large. Its source data was left unchanged.");
        }
        if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || !Number.isSafeInteger(chunk.capturedAt ?? 0) || (chunk.capturedAt ?? 0) < 0) {
          throw new Error("A saved audio chunk has invalid timing data. Its source data was left unchanged.");
        }
        const frame = new Uint8Array(1 + 36 + 1 + 8 + 8 + 4 + 4);
        const view = new DataView(frame.buffer);
        frame[0] = 1;
        frame.set(idBytes, 1);
        frame[37] = chunk.channel === "mic" ? 0 : 1;
        view.setBigUint64(38, BigInt(chunk.sequence), true);
        view.setBigUint64(46, BigInt(chunk.capturedAt ?? 0), true);
        view.setUint32(54, chunk.bytes.length, true);
        view.setUint32(58, crc32(chunk.bytes), true);
        await writer.write(frame);
        await writer.write(chunk.bytes.slice().buffer as ArrayBuffer);
        chunkCount += 1;
        audioBytes += chunk.bytes.length;
      }
    }
    const trailer = new Uint8Array(9);
    trailer[0] = 0xff;
    new DataView(trailer.buffer).setBigUint64(1, BigInt(chunkCount), true);
    await writer.write(trailer);
    await writer.close();
    return { meetingCount: meetings.length, chunkCount, audioBytes };
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}
