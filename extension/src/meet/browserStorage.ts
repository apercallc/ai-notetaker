import type { BrowserAudioChannel } from "../types";
import type { BrowserMeetChunk } from "./browserProcessing";

const DATABASE_NAME = "ai-notetaker-meet-capture";
const DATABASE_VERSION = 1;
const STORE_NAME = "chunks";

interface StoredChunk {
  id: string;
  meetingId: string;
  channel: BrowserAudioChannel;
  sequence: number;
  bytes: ArrayBuffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Meet capture storage could not open"));
  });
}

export async function appendBrowserMeetChunk(meetingId: string, channel: BrowserAudioChannel, sequence: number, bytes: Uint8Array): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id: `${meetingId}:${sequence}`, meetingId, channel, sequence, bytes: bytes.slice().buffer } satisfies StoredChunk);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Meet audio could not be saved"));
  });
  db.close();
}

export async function listBrowserMeetChunks(meetingId: string): Promise<BrowserMeetChunk[]> {
  const db = await openDatabase();
  const records = await new Promise<StoredChunk[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as StoredChunk[]).filter((item) => item.meetingId === meetingId));
    request.onerror = () => reject(request.error ?? new Error("Meet audio could not be read"));
  });
  db.close();
  return records
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => ({ channel: item.channel, sequence: item.sequence, bytes: new Uint8Array(item.bytes) }));
}

export async function clearBrowserMeetChunks(meetingId: string): Promise<void> {
  const db = await openDatabase();
  const records = await listBrowserMeetChunks(meetingId);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    records.forEach((record) => store.delete(`${meetingId}:${record.sequence}`));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Meet audio could not be deleted"));
  });
  db.close();
}
