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
} as const;

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => resolve(items[key] as T | undefined));
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

export async function getSettings(): Promise<NotetakerSettings> {
  const stored = await storageGet<NotetakerSettings>(KEYS.settings);
  return stored ? { ...DEFAULT_SETTINGS, ...stored } : DEFAULT_SETTINGS;
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

export async function listMeetings(): Promise<MeetingRecord[]> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  const meetings = await Promise.all(index.map((id) => getMeeting(id)));
  return meetings
    .filter((m): m is MeetingRecord => m !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getMeeting(id: string): Promise<MeetingRecord | null> {
  const record = await storageGet<MeetingRecord>(KEYS.meetingPrefix + id);
  return record ?? null;
}

export async function saveMeeting(meeting: MeetingRecord): Promise<void> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  const nextIndex = index.includes(meeting.id) ? index : [...index, meeting.id];
  await storageSet({
    [KEYS.meetingPrefix + meeting.id]: meeting,
    [KEYS.meetingsIndex]: nextIndex,
  });
}

export async function deleteMeeting(id: string): Promise<void> {
  const index = (await storageGet<string[]>(KEYS.meetingsIndex)) ?? [];
  await storageSet({ [KEYS.meetingsIndex]: index.filter((existingId) => existingId !== id) });
  await storageRemove(KEYS.meetingPrefix + id);
}
