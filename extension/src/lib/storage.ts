/**
 * All extension-side persistence lives in chrome.storage.local ONLY.
 * Never chrome.storage.sync — that ships data (including API keys) to
 * Google's sync servers, which is a hard constraint (see extension/CLAUDE.md
 * and the root CLAUDE.md non-negotiable constraints list). Do not add a
 * `.sync` call anywhere in this file.
 */
import { DEFAULT_SETTINGS, type MeetingRecord, type NotetakerSettings, type ProcessingMode } from "../types";

const KEYS = {
  settings: "notetaker.settings",
  pairingToken: "notetaker.pairingToken",
  meetingsIndex: "notetaker.meetings.index", // ordered list of meeting IDs
  meetingPrefix: "notetaker.meeting.", // + id
  webappSyncOutbox: "notetaker.webappSync.outbox",
  transcriptionCachePrefix: "notetaker.transcriptionCache.", // + meeting id
  remindedCalls: "notetaker.remindedCalls",
  widgetPosition: "notetaker.widget.position",
} as const;

function validManagedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function storageGet<T>(key: string | string[]): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(typeof key === "string" ? (items[key] as T | undefined) : (items as T));
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

export async function getSettings(): Promise<NotetakerSettings> {
  const stored = await storageGet<NotetakerSettings>(KEYS.settings);
  // Callers mutate the settings they get back (onboarding edits it in place),
  // so never hand out DEFAULT_SETTINGS itself or any array/object inside it.
  const defaults = structuredClone(DEFAULT_SETTINGS);
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    apiKeys: { ...defaults.apiKeys, ...(stored.apiKeys ?? {}) },
    processingMode:
      stored.processingMode?.kind === "managed" &&
      stored.managedService &&
      validManagedIdentity(stored.managedService.accountId) &&
      validManagedIdentity(stored.managedService.workspaceId) &&
      validManagedIdentity(stored.managedService.accessToken) &&
      validManagedIdentity(stored.managedService.baseUrl)
        ? {
            kind: "managed",
            accountId: stored.managedService.accountId,
            workspaceId: stored.managedService.workspaceId,
            plan: stored.managedService.plan,
          }
        : ({ kind: "local_byok" } satisfies ProcessingMode),
    managedService:
      stored.managedService && typeof stored.managedService === "object"
        ? {
            baseUrl: typeof stored.managedService.baseUrl === "string" ? stored.managedService.baseUrl.replace(/\/$/, "") : "",
            accessToken: typeof stored.managedService.accessToken === "string" ? stored.managedService.accessToken : "",
            accountId: typeof stored.managedService.accountId === "string" ? stored.managedService.accountId : "",
            workspaceId: typeof stored.managedService.workspaceId === "string" ? stored.managedService.workspaceId : "",
            plan: typeof stored.managedService.plan === "string" ? stored.managedService.plan : "free",
          }
        : defaults.managedService,
    defaultMeetingMode: stored.defaultMeetingMode ?? defaults.defaultMeetingMode,
    customVocabulary: Array.isArray(stored.customVocabulary)
      ? stored.customVocabulary.filter((term): term is string => typeof term === "string").slice(0, 100)
      : defaults.customVocabulary,
    customSummaryInstructions:
      typeof stored.customSummaryInstructions === "string"
        ? stored.customSummaryInstructions.slice(0, 4_000)
        : defaults.customSummaryInstructions,
    showMeetWidget: typeof stored.showMeetWidget === "boolean" ? stored.showMeetWidget : defaults.showMeetWidget,
    calendarReminders: typeof stored.calendarReminders === "boolean" ? stored.calendarReminders : defaults.calendarReminders,
    drive: stored.drive && typeof stored.drive === "object" ? stored.drive : defaults.drive,
  };
}

export async function saveSettings(settings: NotetakerSettings): Promise<void> {
  await storageSet({ [KEYS.settings]: settings });
}

export async function getPairingToken(): Promise<string | null> {
  const token = await storageGet<string>(KEYS.pairingToken);
  return token ?? null;
}

export async function savePairingToken(token: string): Promise<void> {
  await storageSet({ [KEYS.pairingToken]: token });
}

/**
 * Removes only the local browser copy of the Native Messaging pairing token.
 * The helper requests a fresh token on the next hello, which lets a new
 * Chrome profile recover after its local storage was cleared without asking
 * the user to find and delete an app-data file by hand.
 */
export async function clearPairingToken(): Promise<void> {
  await storageRemove(KEYS.pairingToken);
}

const MEETING_STATUSES = new Set(["recording", "processing", "complete", "error"]);

/**
 * A stored meeting can be partial or corrupt (an interrupted write, an older
 * build, manual tampering). Every consumer assumes `transcript`/`actionItems`
 * are arrays and `startedAt` a string, so one bad record would otherwise break
 * the popup, search, widget and inbox. Repair what is repairable; drop what is
 * not (no id means it cannot be addressed at all).
 */
export function normalizeMeeting(raw: unknown): MeetingRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Partial<MeetingRecord> & Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const startedAtValid = typeof record.startedAt === "string" && !Number.isNaN(Date.parse(record.startedAt));
  return {
    ...(record as MeetingRecord),
    title: typeof record.title === "string" && record.title.trim() ? record.title : "Untitled meeting",
    startedAt: startedAtValid ? (record.startedAt as string) : new Date(0).toISOString(),
    transcript: Array.isArray(record.transcript) ? record.transcript : [],
    actionItems: Array.isArray(record.actionItems) ? record.actionItems : [],
    summary: typeof record.summary === "string" ? record.summary : null,
    // An unknown status would render no controls at all; "error" at least offers Retry/Delete.
    status: MEETING_STATUSES.has(record.status as string) ? (record.status as MeetingRecord["status"]) : "error",
  };
}

/**
 * The index is append-ordered because meetings are created chronologically.
 * Reading only its tail keeps the popup cheap even after a year of notes.
 * Callers that need the complete archive can omit the limit.
 */
export async function listMeetings(limit?: number, query?: string): Promise<MeetingRecord[]> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  const normalizedQuery = query?.trim().slice(0, 200).toLocaleLowerCase();
  // A search must inspect the whole archive before applying a display limit;
  // the normal popup path still reads only its newest five records.
  const ids = normalizedQuery ? index : limit === undefined ? index : index.slice(-Math.max(0, limit));
  // Fetch the selected records in one storage operation. Searching is an
  // archive-wide operation, so issuing one request per meeting makes older
  // profiles increasingly slow and can exhaust the browser's callback queue.
  const records = ids.length
    ? ((await storageGet<Record<string, MeetingRecord>>(ids.map((id) => KEYS.meetingPrefix + id))) ?? {})
    : {};
  const meetings = ids.map((id) => normalizeMeeting(records[KEYS.meetingPrefix + id]));
  const matchingMeetings = meetings.filter((meeting): meeting is MeetingRecord => {
    if (!meeting) return false;
    if (!normalizedQuery) return true;
    return [
      meeting.title,
      meeting.summary ?? "",
      ...meeting.transcript.map((segment) => segment.text),
      ...meeting.actionItems.flatMap((item) => [item.text, item.owner ?? ""]),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  return matchingMeetings
    .filter((m): m is MeetingRecord => m !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getMeeting(id: string): Promise<MeetingRecord | null> {
  return normalizeMeeting(await storageGet<unknown>(KEYS.meetingPrefix + id));
}

type MeetingMutation<T> = () => Promise<T>;
const meetingWriteQueues = new Map<string, Promise<void>>();

function enqueueMeetingMutation<T>(id: string, mutation: MeetingMutation<T>): Promise<T> {
  const previous = meetingWriteQueues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  const tracked = current.then(
    () => undefined,
    () => undefined,
  );
  meetingWriteQueues.set(id, tracked);
  return current.finally(() => {
    if (meetingWriteQueues.get(id) === tracked) meetingWriteQueues.delete(id);
  });
}

// Per-meeting queues serialize one meeting's writes, but the index is shared by
// every meeting: two meetings doing read-modify-write on it at once would drop
// an id (a new recording vanishing, or a deleted one returning). One global
// queue covers every index read-modify-write.
let meetingsIndexQueue: Promise<void> = Promise.resolve();

function withMeetingsIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const current = meetingsIndexQueue.catch(() => undefined).then(task);
  meetingsIndexQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function saveMeetingUnlocked(meeting: MeetingRecord): Promise<void> {
  await withMeetingsIndexLock(async () => {
    const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
    // Already indexed (every live-transcript update): leave the index untouched.
    if (index.includes(meeting.id)) {
      await storageSet({ [KEYS.meetingPrefix + meeting.id]: meeting });
      return;
    }
    await storageSet({
      [KEYS.meetingPrefix + meeting.id]: meeting,
      [KEYS.meetingsIndex]: [...index, meeting.id],
    });
  });
}

export function saveMeeting(meeting: MeetingRecord): Promise<void> {
  return enqueueMeetingMutation(meeting.id, () => saveMeetingUnlocked(meeting));
}

/** Apply a read-modify-write update without losing concurrent transcript events. */
export function updateMeeting(
  id: string,
  updater: (meeting: MeetingRecord) => MeetingRecord | Promise<MeetingRecord>,
): Promise<MeetingRecord | null> {
  return enqueueMeetingMutation(id, async () => {
    const meeting = await getMeeting(id);
    if (!meeting) return null;
    const updated = await updater(meeting);
    await saveMeetingUnlocked(updated);
    return updated;
  });
}

/**
 * Transcribed segments of a Meet call, saved as each finishes. A retry after a failed
 * summary (or a failed later segment) reuses them instead of paying for every segment again.
 */
export type TranscriptionSegmentCache = Record<string, unknown[]>;

export async function getTranscriptionSegment(meetingId: string, key: string): Promise<unknown[] | undefined> {
  const cache = await storageGet<TranscriptionSegmentCache>(KEYS.transcriptionCachePrefix + meetingId);
  const lines = cache?.[key];
  return Array.isArray(lines) ? lines : undefined;
}

export async function saveTranscriptionSegment(meetingId: string, key: string, lines: unknown[]): Promise<void> {
  const cacheKey = KEYS.transcriptionCachePrefix + meetingId;
  const cache = (await storageGet<TranscriptionSegmentCache>(cacheKey)) ?? {};
  await storageSet({ [cacheKey]: { ...cache, [key]: lines } });
}

export async function clearTranscriptionCache(meetingId: string): Promise<void> {
  await storageRemove(KEYS.transcriptionCachePrefix + meetingId);
}

export async function deleteMeeting(id: string): Promise<void> {
  return enqueueMeetingMutation(id, async () => {
    await clearTranscriptionCache(id).catch(() => undefined);
    // Remove the record first. If that fails, the meeting is still listed and the user can retry;
    // the other order orphaned a record (with its transcript) that no screen could reach or delete.
    await storageRemove(KEYS.meetingPrefix + id);
    await withMeetingsIndexLock(async () => {
      const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
      await storageSet({ [KEYS.meetingsIndex]: index.filter((existingId) => existingId !== id) });
    });
    await removeWebappSyncOutbox(id);
  });
}

const MAX_WEBAPP_OUTBOX_ITEMS = 50;
let webappOutboxWriteQueue: Promise<void> = Promise.resolve();

function enqueueWebappOutboxMutation(mutation: (outbox: MeetingRecord[]) => MeetingRecord[]): Promise<void> {
  const current = webappOutboxWriteQueue.catch(() => undefined).then(async () => {
    const outbox = await getWebappSyncOutbox();
    await storageSet({ [KEYS.webappSyncOutbox]: mutation(outbox) });
  });
  webappOutboxWriteQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function getWebappSyncOutbox(): Promise<MeetingRecord[]> {
  const stored = await storageGet<MeetingRecord[]>(KEYS.webappSyncOutbox);
  return Array.isArray(stored)
    ? stored.filter((meeting): meeting is MeetingRecord => !!meeting && typeof meeting.id === "string")
    : [];
}

export async function queueWebappSync(meeting: MeetingRecord): Promise<void> {
  await enqueueWebappOutboxMutation((outbox) => [...outbox.filter((queued) => queued.id !== meeting.id), meeting].slice(-MAX_WEBAPP_OUTBOX_ITEMS));
}

export async function removeWebappSyncOutbox(id: string): Promise<void> {
  await enqueueWebappOutboxMutation((outbox) => outbox.filter((meeting) => meeting.id !== id));
}

export interface RemindedCall {
  url: string;
  at: number;
}

/** Calls already reminded about, keyed by notification id, so a call is announced once. */
export async function getRemindedCalls(): Promise<Record<string, RemindedCall>> {
  const stored = await storageGet<Record<string, RemindedCall>>(KEYS.remindedCalls);
  return stored && typeof stored === "object" ? stored : {};
}

export async function saveRemindedCalls(calls: Record<string, RemindedCall>): Promise<void> {
  await storageSet({ [KEYS.remindedCalls]: calls });
}

export interface WidgetPosition {
  x: number;
  y: number;
}

/** Where the user last dropped the in-call widget. Owned here so the content script never touches storage. */
export async function getWidgetPosition(): Promise<WidgetPosition | null> {
  const stored = await storageGet<Partial<WidgetPosition>>(KEYS.widgetPosition);
  return isWidgetPosition(stored) ? { x: stored.x, y: stored.y } : null;
}

export async function saveWidgetPosition(position: WidgetPosition): Promise<void> {
  if (!isWidgetPosition(position)) return;
  await storageSet({ [KEYS.widgetPosition]: { x: Math.round(position.x), y: Math.round(position.y) } });
}

function isWidgetPosition(value: unknown): value is WidgetPosition {
  const candidate = value as Partial<WidgetPosition> | null | undefined;
  return (
    typeof candidate?.x === "number" &&
    typeof candidate?.y === "number" &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Math.abs(candidate.x) < 100_000 &&
    Math.abs(candidate.y) < 100_000
  );
}
