/**
 * All extension-side persistence lives in chrome.storage.local ONLY.
 * Never chrome.storage.sync — that ships data (including API keys) to
 * Google's sync servers, which is a hard constraint (see extension/CLAUDE.md
 * and the root CLAUDE.md non-negotiable constraints list). Do not add a
 * `.sync` call anywhere in this file.
 */
import { DEFAULT_SETTINGS, type MeetingRecord, type NotetakerSettings } from "../types";

const KEYS = {
  settings: "notetaker.settings",
  pairingToken: "notetaker.pairingToken",
  meetingsIndex: "notetaker.meetings.index", // ordered list of meeting IDs
  meetingPrefix: "notetaker.meeting.", // + id
  webappSyncOutbox: "notetaker.webappSync.outbox",
} as const;

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items[key] as T | undefined);
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
  if (!stored) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys ?? {}) },
    defaultMeetingMode: stored.defaultMeetingMode ?? DEFAULT_SETTINGS.defaultMeetingMode,
    customVocabulary: Array.isArray(stored.customVocabulary)
      ? stored.customVocabulary.filter((term): term is string => typeof term === "string").slice(0, 100)
      : DEFAULT_SETTINGS.customVocabulary,
    customSummaryInstructions:
      typeof stored.customSummaryInstructions === "string"
        ? stored.customSummaryInstructions.slice(0, 4_000)
        : DEFAULT_SETTINGS.customSummaryInstructions,
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
 * The index is append-ordered because meetings are created chronologically.
 * Reading only its tail keeps the popup cheap even after a year of notes.
 * Callers that need the complete archive can omit the limit.
 */
export async function listMeetings(limit?: number, query?: string): Promise<MeetingRecord[]> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  // A search must inspect the whole archive before applying a display limit;
  // the normal popup path still reads only its newest five records.
  const ids = normalizedQuery ? index : limit === undefined ? index : index.slice(-Math.max(0, limit));
  const meetings = await Promise.all(ids.map((id) => getMeeting(id)));
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
  const record = await storageGet<MeetingRecord>(KEYS.meetingPrefix + id);
  return record ?? null;
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

async function saveMeetingUnlocked(meeting: MeetingRecord): Promise<void> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  const nextIndex = index.includes(meeting.id) ? index : [...index, meeting.id];
  await storageSet({
    [KEYS.meetingPrefix + meeting.id]: meeting,
    [KEYS.meetingsIndex]: nextIndex,
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

export async function deleteMeeting(id: string): Promise<void> {
  return enqueueMeetingMutation(id, async () => {
    const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
    const outbox = await getWebappSyncOutbox();
    await storageSet({
      [KEYS.meetingsIndex]: index.filter((existingId) => existingId !== id),
      [KEYS.webappSyncOutbox]: outbox.filter((meeting) => meeting.id !== id),
    });
    await storageRemove(KEYS.meetingPrefix + id);
  });
}

const MAX_WEBAPP_OUTBOX_ITEMS = 50;

export async function getWebappSyncOutbox(): Promise<MeetingRecord[]> {
  const stored = await storageGet<MeetingRecord[]>(KEYS.webappSyncOutbox);
  return Array.isArray(stored)
    ? stored.filter((meeting): meeting is MeetingRecord => !!meeting && typeof meeting.id === "string")
    : [];
}

export async function queueWebappSync(meeting: MeetingRecord): Promise<void> {
  const outbox = await getWebappSyncOutbox();
  const next = [...outbox.filter((queued) => queued.id !== meeting.id), meeting].slice(-MAX_WEBAPP_OUTBOX_ITEMS);
  await storageSet({ [KEYS.webappSyncOutbox]: next });
}

export async function removeWebappSyncOutbox(id: string): Promise<void> {
  const outbox = await getWebappSyncOutbox();
  await storageSet({ [KEYS.webappSyncOutbox]: outbox.filter((meeting) => meeting.id !== id) });
}
