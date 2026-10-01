import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chunks: [] as Array<{ id: string; objectKey: string }>,
  active: 0,
  peak: 0,
  failureKey: "",
  deleted: [] as string[],
  deleteRows: vi.fn(),
  findUploads: vi.fn<(input: unknown) => Promise<unknown[]>>(async () => []),
  findMeetings: vi.fn(async () => []),
  findChunks: vi.fn(),
}));
vi.mock("./db", () => ({ prisma: {
  uploadChunk: { findMany: state.findChunks, deleteMany: state.deleteRows },
  directUploadTicket: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
  managedUpload: { findMany: state.findUploads, updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn() },
  meeting: { findMany: state.findMeetings },
} }));
const cursors = new Map<string, string>();
vi.mock("./maintenanceCursor", () => ({
  readMaintenanceCursor: async (id: string) => cursors.get(id),
  writeMaintenanceCursor: async (id: string, value?: string) => { if (value) cursors.set(id, value); else cursors.delete(id); },
}));
vi.mock("./objectStorage", () => ({
  getObject: vi.fn(),
  deleteObject: async (key: string) => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    try {
      await Promise.resolve();
      if (key === state.failureKey) throw new Error("storage unavailable");
      state.deleted.push(key);
    } finally {
      state.active -= 1;
    }
  },
}));
import { deleteManagedUploadAudio, expireManagedUploads } from "./managedJobs";

beforeEach(() => {
  vi.clearAllMocks();
  cursors.clear();
  state.active = 0;
  state.peak = 0;
  state.failureKey = "";
  state.deleted = [];
  state.chunks = Array.from({ length: 40 }, (_, index) => ({ id: String(index), objectKey: `uploads/chunk-${index}` }));
  state.findChunks.mockImplementation(async () => state.chunks);
});

describe("bounded managed audio cleanup", () => {
  it("caps parallel object deletes and removes all chunk rows after success", async () => {
    await expect(deleteManagedUploadAudio("upload")).resolves.toBe(true);
    expect(state.peak).toBe(16);
    expect(state.deleted).toHaveLength(40);
    expect(state.deleteRows).toHaveBeenCalledOnce();
  });

  it("keeps cleanup rows for retry while still attempting later batches after a failure", async () => {
    state.failureKey = "uploads/chunk-12";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deleteManagedUploadAudio("upload")).resolves.toBe(false);
      expect(state.peak).toBe(16);
      expect(state.deleted).toHaveLength(39);
      expect(state.deleted).toContain("uploads/chunk-39");
      expect(state.deleteRows).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("bounds each expiry and legacy cleanup batch", async () => {
    await expect(expireManagedUploads()).resolves.toBe(0);
    expect(state.findUploads).toHaveBeenCalledWith(expect.objectContaining({ take: 100, orderBy: [{ expiresAt: "asc" }, { id: "asc" }] }));
    expect(state.findMeetings).toHaveBeenCalledWith(expect.objectContaining({ take: 100, orderBy: { id: "asc" } }));
  });

  it("advances past a full batch of undeletable uploads and wraps to retry them later", async () => {
    const expiresAt = new Date("2026-01-01T00:00:00Z");
    state.findUploads.mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({ id: `poison-${index}`, expiresAt, status: "expired", jobs: [] })) as never);
    state.findUploads.mockResolvedValueOnce([{ id: "later", expiresAt: new Date("2026-01-02T00:00:00Z"), status: "expired", jobs: [] }] as never);
    state.findChunks.mockImplementation(async ({ where }: { where: { uploadId: string } }) => [{ id: where.uploadId, objectKey: where.uploadId === "later" ? "safe" : "poison" }]);
    state.failureKey = "poison";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(expireManagedUploads()).resolves.toBe(0);
      await expect(expireManagedUploads()).resolves.toBe(1);
      expect(state.deleted).toContain("safe");
      expect(state.findUploads.mock.calls[1]?.[0]).toMatchObject({ where: { AND: [{ OR: [{ expiresAt: { gt: expiresAt } }, { expiresAt, id: { gt: "poison-99" } }] }] } });
      await expireManagedUploads();
      expect(state.findUploads.mock.calls[2]?.[0]).not.toHaveProperty("where.AND");
    } finally {
      log.mockRestore();
    }
  });
});
