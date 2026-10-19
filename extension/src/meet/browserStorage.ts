import type { BrowserAudioChannel } from "../types";
import type { BrowserMeetChunk } from "./browserProcessing";

const DATABASE_NAME = "ai-notetaker-meet-capture";
/**
 * v2 adds the [meetingId, sequence] index so one meeting can be read in order without scanning every meeting.
 * v3 adds a metadata index (size and capture time in the key) so the archive inventory never loads audio.
 * Both upgrades only add indexes: no stored record is rewritten or dropped.
 */
const DATABASE_VERSION = 3;
const STORE_NAME = "chunks";
const MEETING_INDEX = "meetingSequence";
/**
 * Keyed [meetingId, sequence, byteLength, capturedAt]. Only records written
 * since v3 carry `byteLength`; IndexedDB leaves records without every key
 * path out of an index, so older chunks are simply absent from it and the
 * inventory falls back to reading those meetings' values.
 */
const META_INDEX = "meetingChunkMeta";
const DEFAULT_BATCH_SIZE = 64;

interface StoredChunk {
  id: string;
  meetingId: string;
  channel: BrowserAudioChannel;
  sequence: number;
  bytes: ArrayBuffer;
  /** Epoch ms when the service worker received the chunk; absent on chunks saved before v2. */
  capturedAt?: number;
  /** `bytes.byteLength`, duplicated so the metadata index can carry it; absent on chunks saved before v3. */
  byteLength?: number;
}

export interface BrowserMeetArchiveStats {
  meetingId: string;
  chunkCount: number;
  totalBytes: number;
  firstCapturedAt: number | null;
  lastSequence: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
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
      if (!store.indexNames.contains(META_INDEX)) store.createIndex(META_INDEX, ["meetingId", "sequence", "byteLength", "capturedAt"]);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        // The caller already gave up after a blocked upgrade; do not leave this connection open.
        db.close();
        return;
      }
      // A future upgrade in another context must never be blocked by this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Meet capture storage could not open"));
    // Another context still holds an older version open and ignored the upgrade request. Without
    // this the open never settles, and every chunk write (and so the recording) hangs behind it.
    request.onblocked = () => {
      abandoned = true;
      reject(new Error("Meet audio storage is busy because another AI Notetaker tab is using an older version. Reload the extension and try again."));
    };
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
  chunkId?: string,
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const id = chunkId === undefined ? `${meetingId}:${sequence}` : `${meetingId}:capture:${chunkId}`;
      const record = { id, meetingId, channel, sequence, bytes: bytes.slice().buffer, capturedAt, byteLength: bytes.byteLength } satisfies StoredChunk;
      if (chunkId === undefined) store.put(record);
      else {
        // Lookup and insertion share one readwrite transaction: concurrent
        // retransmissions and worker restarts retain the first durable copy.
        const existing = store.getKey(id);
        existing.onsuccess = () => {
          if (existing.result === undefined) store.put(record);
        };
      }
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
export async function* streamBrowserMeetChunks(
  meetingId: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
  throughSequence: number = Number.MAX_SAFE_INTEGER,
): AsyncGenerator<BrowserMeetChunk> {
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
          const record = cursor.value as StoredChunk;
          if (record.sequence > throughSequence) return resolve(records);
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

/**
 * Chunk count and total bytes for one meeting. This is what the managed upload
 * uses to write its manifest before streaming chunks one at a time:
 * materializing every chunk (an hour of two-channel 48 kHz PCM16 is ~700 MB)
 * into the service worker at once is a heap exhaustion, not a list operation.
 *
 * Chunks written since v3 are measured from the metadata index's keys alone,
 * so no audio is loaded for them. If the meeting still holds older chunks (no
 * `byteLength`, so absent from that index) it is re-measured from its values,
 * as `browserMeetArchiveInventory` does. All passes share one read transaction.
 */
export async function browserMeetChunkStats(meetingId: string): Promise<{ totalChunks: number; totalBytes: number }> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
      const fail = (request: IDBRequest) => () => reject(request.error ?? new Error("Meet audio could not be read"));
      let allChunks = 0;

      // Pass 3 (only when some chunk predates v3): measure every chunk from its value.
      const measureFromValues = () => {
        let totalChunks = 0;
        let totalBytes = 0;
        const request = store.index(MEETING_INDEX).openCursor(meetingRange(meetingId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve({ totalChunks, totalBytes });
          totalChunks += 1;
          const record = cursor.value as StoredChunk;
          if (record.bytes && typeof record.bytes.byteLength === "number") totalBytes += record.bytes.byteLength;
          cursor.continue();
        };
        request.onerror = fail(request);
      };

      // Pass 2: sizes straight from the metadata index's keys. The upper bound
      // ends after every [meetingId, MAX_SAFE_INTEGER, …] key (arrays sort above
      // numbers), so this covers exactly the sequence range of `meetingRange`.
      const measureFromKeys = () => {
        let totalChunks = 0;
        let totalBytes = 0;
        const range = IDBKeyRange.bound([meetingId, 0], [meetingId, Number.MAX_SAFE_INTEGER, []]);
        const request = store.index(META_INDEX).openKeyCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return totalChunks === allChunks ? resolve({ totalChunks, totalBytes }) : measureFromValues();
          const key = cursor.key;
          if (Array.isArray(key) && typeof key[2] === "number") {
            totalChunks += 1;
            totalBytes += key[2];
          }
          cursor.continue();
        };
        request.onerror = fail(request);
      };

      // Pass 1: how many chunks the meeting holds, keys only.
      const request = store.index(MEETING_INDEX).count(meetingRange(meetingId));
      request.onsuccess = () => {
        allChunks = request.result;
        measureFromKeys();
      };
      request.onerror = fail(request);
    });
  } finally {
    db.close();
  }
}

function emptyStats(meetingId: string): BrowserMeetArchiveStats {
  return { meetingId, chunkCount: 0, totalBytes: 0, firstCapturedAt: null, lastSequence: -1 };
}

function addCapturedAt(stats: BrowserMeetArchiveStats, capturedAt: unknown): void {
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) return;
  stats.firstCapturedAt = stats.firstCapturedAt === null ? capturedAt : Math.min(stats.firstCapturedAt, capturedAt);
}

function addSequence(stats: BrowserMeetArchiveStats, sequence: unknown): void {
  if (Number.isSafeInteger(sequence) && (sequence as number) >= 0) stats.lastSequence = Math.max(stats.lastSequence, sequence as number);
}

/**
 * Per-meeting archive inventory. Chunks written since v3 are measured from the
 * metadata index's keys alone, so no audio is loaded for them. A meeting that
 * still holds older chunks (no `byteLength`) is re-measured from its values,
 * exactly as before. All passes share one read transaction, so a chunk written
 * mid-inventory cannot make the counts disagree.
 */
export async function browserMeetArchiveInventory(): Promise<BrowserMeetArchiveStats[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
      const fail = (request: IDBRequest) => () => reject(request.error ?? new Error("Meet audio could not be inventoried"));
      const meetings = new Map<string, BrowserMeetArchiveStats>();
      const allCounts = new Map<string, number>();
      const finish = () => resolve([...meetings.values()].sort((a, b) => a.meetingId.localeCompare(b.meetingId)));

      // Pass 3: meetings with pre-v3 chunks are measured from their values.
      const measureLegacy = (pending: string[]) => {
        const meetingId = pending.shift();
        if (meetingId === undefined) return finish();
        const stats = emptyStats(meetingId);
        const request = store.index(MEETING_INDEX).openCursor(meetingRange(meetingId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            if (stats.chunkCount > 0) meetings.set(meetingId, stats);
            else meetings.delete(meetingId);
            return measureLegacy(pending);
          }
          const record = cursor.value as StoredChunk;
          if (record.bytes && typeof record.bytes.byteLength === "number") {
            stats.chunkCount += 1;
            stats.totalBytes += record.bytes.byteLength;
            addSequence(stats, record.sequence);
            addCapturedAt(stats, record.capturedAt);
          }
          cursor.continue();
        };
        request.onerror = fail(request);
      };

      // Pass 2: sizes and capture times straight from the metadata index's keys.
      const measureFromKeys = () => {
        const request = store.index(META_INDEX).openKeyCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            const legacy = [...allCounts].filter(([meetingId, count]) => (meetings.get(meetingId)?.chunkCount ?? 0) !== count).map(([meetingId]) => meetingId);
            return measureLegacy(legacy);
          }
          const key = cursor.key;
          if (Array.isArray(key) && typeof key[0] === "string" && typeof key[2] === "number") {
            const meetingId = key[0];
            let stats = meetings.get(meetingId);
            if (!stats) meetings.set(meetingId, (stats = emptyStats(meetingId)));
            stats.chunkCount += 1;
            stats.totalBytes += key[2];
            addSequence(stats, key[1]);
            addCapturedAt(stats, key[3]);
          }
          cursor.continue();
        };
        request.onerror = fail(request);
      };

      // Pass 1: how many chunks each meeting holds, keys only.
      const request = store.index(MEETING_INDEX).openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return measureFromKeys();
        const key = cursor.key;
        if (Array.isArray(key) && typeof key[0] === "string") allCounts.set(key[0], (allCounts.get(key[0]) ?? 0) + 1);
        cursor.continue();
      };
      request.onerror = fail(request);
    });
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
