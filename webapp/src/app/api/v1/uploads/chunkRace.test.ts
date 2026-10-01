import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | { checksum: string; byteLength: number; channel: string; objectKey: string },
  reads: 0,
  bothRead: null as null | (() => void),
  readBarrier: Promise.resolve(),
  transactionTail: Promise.resolve(),
}));

vi.mock("@/lib/managedAuth", () => ({
  getManagedSession: async () => ({ workspaceId: "race-workspace" }),
  managedUnauthorized: () => Response.json({}, { status: 401 }),
}));
vi.mock("@/lib/managedJobs", async () => {
  const { ValidationError } = await import("@/lib/meetings");
  return {
  getUpload: async () => ({ totalChunks: 1, totalBytes: 4, status: "uploading" }),
  MAX_CHUNK_BYTES: 8 * 1024 * 1024,
  ManagedValidationError: class extends ValidationError {},
  readManagedBytes: async (request: Request) => new Uint8Array(await request.arrayBuffer()),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    uploadChunk: {
      findUnique: async () => {
        // Both requests must pass the optimistic read before either writes.
        const initial = state.row;
        state.reads += 1;
        if (state.reads === 2) state.bothRead?.();
        await state.readBarrier;
        return initial;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = state.transactionTail;
      let release!: () => void;
      state.transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({
          managedUpload: { updateMany: async () => ({ count: 1 }) },
          uploadChunk: {
            findUnique: async () => state.row,
            aggregate: async () => ({ _sum: { byteLength: state.row?.byteLength ?? 0 } }),
            create: async ({ data }: { data: NonNullable<typeof state.row> }) => { state.row = data; },
          },
        });
      } finally {
        release();
      }
    },
  },
}));

import { PUT } from "./[uploadId]/chunks/[chunkIndex]/route";
import { getObject } from "@/lib/objectStorage";

let directory: string;
const originalStorageDir = process.env.OBJECT_STORAGE_DIR;

beforeEach(async () => {
  state.row = null;
  state.reads = 0;
  state.transactionTail = Promise.resolve();
  state.readBarrier = new Promise<void>((resolve) => { state.bothRead = resolve; });
  directory = await mkdtemp(path.join(os.tmpdir(), "notetaker-chunk-race-"));
  vi.stubEnv("OBJECT_STORAGE_DIR", directory);
  vi.stubEnv("R2_BUCKET", "");
  vi.stubEnv("S3_BUCKET", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (originalStorageDir === undefined) delete process.env.OBJECT_STORAGE_DIR;
  else process.env.OBJECT_STORAGE_DIR = originalStorageDir;
  await rm(directory, { recursive: true, force: true });
});

describe("concurrent managed chunk staging", () => {
  it.each(["mic", "speaker"])("preserves the committed audio when an identical %s request loses the race", async (secondChannel) => {
    const bytes = new Uint8Array([0, 0, 0, 0]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const send = (channel: string) => PUT(new Request("http://localhost/api/v1/uploads/chunk", {
      method: "PUT",
      headers: { "x-audio-channel": channel, "x-chunk-sha256": checksum },
      body: bytes,
    }), { params: Promise.resolve({ uploadId: "race-upload", chunkIndex: "0" }) });

    const responses = await Promise.all([send("mic"), send(secondChannel)]);
    expect(responses.map((response) => response.status).sort()).toEqual(secondChannel === "mic" ? [200, 201] : [201, 400]);
    expect(state.row).not.toBeNull();
    expect(await getObject(state.row!.objectKey)).toEqual(bytes);
    // A losing retry must clean only its own staging file.
    expect(await readdir(path.join(directory, "uploads", "race-workspace", "race-upload"))).toHaveLength(1);
  });
});
