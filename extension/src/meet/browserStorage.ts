import type { BrowserAudioChannel } from "../types";
import type { BrowserMeetChunk } from "./browserProcessing";

const DATABASE_NAME = "ai-notetaker-meet-capture";
/** v2 adds the [meetingId, sequence] index so one meeting can be read in order without scanning every meeting. */
const DATABASE_VERSION = 2;
const STORE_NAME = "chunks";
const MEETING_INDEX = "meetingSequence";
const DEFAULT_BATCH_SIZE = 64;

interface StoredChunk {
  id: string;
  meetingId: string;
  channel: BrowserAudioChannel;
  sequence: number;
  bytes: ArrayBuffer;
  /** Epoch ms when the service worker received the chunk; absent on chunks saved before v2. */
  capturedAt?: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      // Runs for fresh installs (v0) and for v1 databases alike. Existing v1
      // records already carry meetingId + sequence, so creating the index is
      // the whole migration: the browser back-fills it and no raw audio is
      // rewritten or dropped.
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(MEETING_INDEX)) store.createIndex(MEETING_INDEX, ["meetingId", "sequence"]);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A future upgrade in another context must never be blocked by this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Meet capture storage could not open"));
  });
}

function meetingRange(meetingId: string, afterSequence = -1): IDBKeyRange {
  return IDBKeyRange.bound([meetingId, afterSequence + 1], [meetingId, Number.MAX_SAFE_INTEGER]);
}

function toChunk(item: StoredChunk): BrowserMeetChunk {
  return {
    channel: item.channel,
    sequence: item.sequence,
    bytes: new Uint8Array(item.bytes),
    ...(typeof item.capturedAt === "number" ? { capturedAt: item.capturedAt } : {}),
  };
}

export async function appendBrowserMeetChunk(
  meetingId: string,
  channel: BrowserAudioChannel,
  sequence: number,
  bytes: Uint8Array,
  capturedAt: number = Date.now(),
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: `${meetingId}:${sequence}`, meetingId, channel, sequence, bytes: bytes.slice().buffer, capturedAt } satisfies StoredChunk);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Meet audio could not be saved"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Meet audio could not be saved"));
    });
  } finally {
    db.close();
  }
}

/**
 * Streams one meeting's chunks in sequence order, a small batch per
 * transaction, so a long call is never held in memory at once (an hour of
 * 48 kHz PCM16 is ~700 MB across both channels). Each batch gets its own
 * transaction because IndexedDB closes a transaction as soon as the caller
 * awaits anything that is not an IDB request, e.g. a provider upload.
 */
export async function* streamBrowserMeetChunks(meetingId: string, batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<BrowserMeetChunk> {
  const db = await openDatabase();
  try {
    let lastSequence = -1;
    for (;;) {
      const batch = await new Promise<StoredChunk[]>((resolve, reject) => {
        const records: StoredChunk[] = [];
        const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index(MEETING_INDEX).openCursor(meetingRange(meetingId, lastSequence));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(records);
          records.push(cursor.value as StoredChunk);
          if (records.length >= batchSize) return resolve(records);
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("Meet audio could not be read"));
      });
      if (batch.length === 0) return;
      for (const record of batch) yield toChunk(record);
      lastSequence = batch[batch.length - 1]!.sequence;
      if (batch.length < batchSize) return;
    }
  } finally {
    db.close();
  }
}

/** Every chunk of one meeting, in order. Prefer streamBrowserMeetChunks for anything long. */
export async function listBrowserMeetChunks(meetingId: string): Promise<BrowserMeetChunk[]> {
  const db = await openDatabase();
  try {
    const records = await new Promise<StoredChunk[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index(MEETING_INDEX).getAll(meetingRange(meetingId));
      request.onsuccess = () => resolve(request.result as StoredChunk[]);
      request.onerror = () => reject(request.error ?? new Error("Meet audio could not be read"));
    });
    return records.map(toChunk);
  } finally {
    db.close();
  }
}

/** Highest stored sequence for a meeting, or -1 when none: a key-only read that never loads audio bytes. */
export async function lastBrowserMeetSequence(meetingId: string): Promise<number> {
  const db = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index(MEETING_INDEX).openKeyCursor(meetingRange(meetingId), "prev");
      request.onsuccess = () => {
        const key = request.result?.key;
        resolve(Array.isArray(key) && typeof key[1] === "number" ? key[1] : -1);
      };
      request.onerror = () => reject(request.error ?? new Error("Meet audio could not be read"));
    });
  } finally {
    db.close();
  }
}

export async function clearBrowserMeetChunks(meetingId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.index(MEETING_INDEX).openKeyCursor(meetingRange(meetingId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Meet audio could not be deleted"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Meet audio could not be deleted"));
    });
  } finally {
    db.close();
  }
}
