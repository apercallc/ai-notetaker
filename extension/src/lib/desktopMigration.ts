import type { MeetingMode, MeetingRecord, NotetakerSettings } from "../types";
import { sendToBackground } from "./sendToBackground";
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

// Import limits enforced by the desktop app (helper/crates/app/src/desktop_migration.rs).
// A single violating record makes the helper reject the whole archive, so the
// exporter repairs or drops offending records itself and says what it did.
const MAX_MEETINGS = 2_000;
const MAX_SEGMENTS_PER_MEETING = 50_000;
const MAX_TRANSCRIPT_CHARS = 2_000_000;
const MAX_TITLE_CHARS = 200;
const MAX_SEGMENT_CHARS = 25_000;
const MAX_SUMMARY_CHARS = 100_000;
const MAX_ACTION_ITEMS = 1_000;
const MAX_ACTION_TEXT_CHARS = 2_000;
const MAX_ACTION_SHORT_CHARS = 200;
const MAX_VOCAB_TERM_CHARS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const STATUSES = new Set<string>(["recording", "saved", "processing", "complete", "error"]);
const MODES = new Set<string>(["general", "standup", "sales", "one_on_one", "interview", "lecture", "custom"]);

function isRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** Truncates by Unicode code points, matching the desktop app's `chars().count()`. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

function codePoints(value: string): number {
  return value.length <= 1 ? value.length : Array.from(value).length;
}

type ExportMeeting = DesktopMigrationArchive["meetings"][number];

/** Returns a record the desktop app will accept, or null when it cannot be repaired. */
function repairMeeting(meeting: MeetingRecord, changed: { value: boolean }): ExportMeeting | null {
  if (typeof meeting.id !== "string" || !UUID_PATTERN.test(meeting.id) || !isRfc3339(meeting.startedAt) || !STATUSES.has(meeting.status)) return null;
  const note = (didChange: boolean) => { if (didChange) changed.value = true; };

  const cleanedTitle = clip(String(meeting.title ?? "").replace(CONTROL_CHARS, " ").replace(/ {2,}/g, " ").trim(), MAX_TITLE_CHARS).trim();
  const title = cleanedTitle || "Untitled meeting";
  note(title !== meeting.title);

  const startedAt = meeting.startedAt;
  let endedAt: string | null = isRfc3339(meeting.endedAt) ? meeting.endedAt : null;
  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) endedAt = null;
  if (meeting.status === "complete" && endedAt === null) endedAt = startedAt;
  note(endedAt !== (meeting.endedAt ?? null));

  let totalChars = 0;
  const transcript: ExportMeeting["transcript"] = [];
  for (const segment of meeting.transcript ?? []) {
    if (transcript.length >= MAX_SEGMENTS_PER_MEETING) { note(true); break; }
    const text = clip(String(segment.text ?? "").replace(/\0/g, ""), MAX_SEGMENT_CHARS);
    const length = codePoints(text);
    if (totalChars + length > MAX_TRANSCRIPT_CHARS) { note(true); break; }
    totalChars += length;
    const speaker = segment.speaker === "you" || /^them(-\d+)?$/.test(String(segment.speaker)) ? segment.speaker : "them";
    const timestamp = isRfc3339(segment.timestamp) ? segment.timestamp : startedAt;
    note(text !== segment.text || speaker !== segment.speaker || timestamp !== segment.timestamp);
    transcript.push({ speaker, text, timestamp, isFinal: segment.isFinal });
  }

  const summary = typeof meeting.summary === "string" ? clip(meeting.summary, MAX_SUMMARY_CHARS) : null;
  note(summary !== (meeting.summary ?? null));

  const items = meeting.actionItems ?? [];
  note(items.length > MAX_ACTION_ITEMS);
  const actionItems: ExportMeeting["actionItems"] = items.slice(0, MAX_ACTION_ITEMS).map((item) => {
    const status = item.status === "open" || item.status === "done" ? item.status : undefined;
    const dueAt = isRfc3339(item.dueAt) ? item.dueAt : item.dueAt === undefined ? undefined : null;
    const completedAt = isRfc3339(item.completedAt) ? item.completedAt : item.completedAt === undefined ? undefined : null;
    const text = clip(String(item.text ?? ""), MAX_ACTION_TEXT_CHARS);
    const owner = typeof item.owner === "string" ? clip(item.owner, MAX_ACTION_SHORT_CHARS) : item.owner;
    const id = typeof item.id === "string" ? clip(item.id, MAX_ACTION_SHORT_CHARS) : item.id;
    note(text !== item.text || owner !== item.owner || id !== item.id || status !== item.status || dueAt !== item.dueAt || completedAt !== item.completedAt);
    return { text, owner, id, status, dueAt, completedAt };
  });

  const mode = typeof meeting.mode === "string" && MODES.has(meeting.mode) ? (meeting.mode as MeetingMode) : undefined;
  note(mode !== meeting.mode);
  return { id: meeting.id, title, startedAt, endedAt, mode, status: meeting.status, transcript, summary, actionItems };
}

export interface DesktopMigrationReport {
  archive: DesktopMigrationArchive;
  /** Human-readable notes about records that were repaired or left out. Empty when nothing changed. */
  adjustments: string[];
}

/** Whitelist only portable preferences and note text, repaired to the desktop import limits. */
export function buildDesktopMigrationArchive(
  settings: NotetakerSettings,
  meetings: MeetingRecord[],
  exportedAt: string = new Date().toISOString(),
): DesktopMigrationReport {
  const adjustments: string[] = [];
  const exported: ExportMeeting[] = [];
  let skipped = 0;
  let repaired = 0;
  for (const meeting of meetings) {
    const changed = { value: false };
    const repairedMeeting = repairMeeting(meeting, changed);
    if (!repairedMeeting) { skipped += 1; continue; }
    if (exported.length >= MAX_MEETINGS) continue;
    if (changed.value) repaired += 1;
    exported.push(repairedMeeting);
  }
  const overLimit = meetings.length - skipped - exported.length;
  if (skipped > 0) adjustments.push(`${skipped} meeting record${skipped === 1 ? " was" : "s were"} left out because ${skipped === 1 ? "its" : "their"} id or start time is invalid for the desktop app.`);
  if (overLimit > 0) adjustments.push(`${overLimit} older meeting record${overLimit === 1 ? " was" : "s were"} left out: the desktop app imports at most ${MAX_MEETINGS} meetings per file.`);
  if (repaired > 0) adjustments.push(`${repaired} meeting record${repaired === 1 ? " was" : "s were"} shortened or corrected to fit the desktop app's import limits.`);

  const vocabulary = (settings.customVocabulary ?? []).map((term) => clip(String(term), MAX_VOCAB_TERM_CHARS)).slice(0, 100);
  return {
    archive: {
      format: "ai-notetaker-desktop-transfer",
      version: DESKTOP_MIGRATION_VERSION,
      exportedAt,
      settings: {
        transcriptionProvider: settings.transcriptionProvider,
        summarizationProvider: settings.summarizationProvider,
        defaultMeetingMode: settings.defaultMeetingMode,
        customVocabulary: vocabulary,
        customSummaryInstructions: clip(settings.customSummaryInstructions, 4_000),
      },
      meetings: exported,
    },
    adjustments,
  };
}

export function createDesktopMigrationArchive(
  settings: NotetakerSettings,
  meetings: MeetingRecord[],
  exportedAt: string = new Date().toISOString(),
): DesktopMigrationArchive {
  return buildDesktopMigrationArchive(settings, meetings, exportedAt).archive;
}

/** Exporting while a call is being recorded would snapshot audio that is still changing. */
export async function assertNoActiveRecording(): Promise<void> {
  let state: { activeMeeting?: unknown } | undefined;
  try {
    state = await sendToBackground<{ activeMeeting?: unknown } | undefined>({ type: "GET_STATE" });
  } catch {
    throw new Error("Could not confirm whether a recording is active. Retry after the extension reconnects; no archive was created.");
  }
  if (!state || !Object.hasOwn(state, "activeMeeting")) {
    throw new Error("Could not confirm whether a recording is active. Retry after the extension reconnects; no archive was created.");
  }
  if (state.activeMeeting === undefined) {
    throw new Error("Could not confirm whether a recording is active. Retry after the extension reconnects; no archive was created.");
  }
  if (state.activeMeeting !== null) throw new Error("A recording is in progress. Stop it before exporting so the archive includes its complete audio.");
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
  settingsInput: NotetakerSettings | Promise<NotetakerSettings>,
  loadMeetings: () => Promise<MeetingRecord[]>,
  exportedAt: string = new Date().toISOString(),
  options: { isRecordingActive?: () => Promise<void> } = {},
): Promise<{ meetingCount: number; chunkCount: number; audioBytes: number; adjustments: string[] }> {
  // Callers pass settings as a pending promise so nothing is awaited before the
  // picker opens (it needs the click's user activation). Silence the promise
  // here so a cancelled picker cannot leave an unhandled rejection behind.
  void Promise.resolve(settingsInput).catch(() => undefined);
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) throw new Error("This Chrome version cannot stream a full audio archive. Export notes only instead.");
  const handle = await picker({
    suggestedName: `ai-notetaker-desktop-transfer-${exportedAt.slice(0, 10)}.ntarchive`,
    types: [{ description: "AI Notetaker transfer archive", accept: { "application/octet-stream": [".ntarchive"] } }],
  });
  const settings = await settingsInput;
  await (options.isRecordingActive ?? assertNoActiveRecording)();
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
    for (const { meetingId } of inventory) {
      if (!UUID_PATTERN.test(meetingId)) throw new Error("A saved audio record has an invalid meeting id. Its source data was left unchanged.");
    }
    const meetingById = new Map(storedMeetings.map((meeting) => [meeting.id, meeting]));
    for (const audio of inventory) {
      if (!meetingById.has(audio.meetingId)) {
        const firstDate = audio.firstCapturedAt === null ? null : new Date(audio.firstCapturedAt);
        const startedAt = firstDate && !Number.isNaN(firstDate.getTime()) ? firstDate.toISOString() : exportedAt;
        meetingById.set(audio.meetingId, {
          id: audio.meetingId,
          title: "Recovered browser audio",
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
    const { archive: notes, adjustments } = buildDesktopMigrationArchive(settings, meetings, exportedAt);
    const exportedIds = new Set(notes.meetings.map((meeting) => meeting.id));
    const audioInventory = inventory.filter(({ meetingId }) => exportedIds.has(meetingId));
    if (audioInventory.length < inventory.length) adjustments.push(`${inventory.length - audioInventory.length} saved audio recording${inventory.length - audioInventory.length === 1 ? " was" : "s were"} left out with ${inventory.length - audioInventory.length === 1 ? "its" : "their"} meeting record.`);
    const manifest = JSON.stringify({
      format: "ai-notetaker-desktop-audio-transfer",
      version: 1,
      sampleRateHz: 48_000,
      notes,
      audioMeetingIds: audioInventory.map(({ meetingId }) => meetingId),
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
    for (const { meetingId, lastSequence } of audioInventory) {
      const idBytes = encoder.encode(meetingId);
      if (idBytes.length !== 36 || !UUID_PATTERN.test(meetingId)) {
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
    return { meetingCount: notes.meetings.length, chunkCount, audioBytes, adjustments };
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}
