import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("./db", () => ({ prisma: { managedUpload: { findFirst } } }));

import { findMeetingRecording } from "./meetingRecording";

beforeEach(() => vi.clearAllMocks());

describe("workspace-scoped managed recording metadata", () => {
  it("returns no recording when there is no completed upload or no chunks for that channel", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await findMeetingRecording("workspace-a", "meeting-a", "mic")).toBeNull();
    findFirst.mockResolvedValueOnce({ meeting: { title: "Call" }, chunks: [] });
    expect(await findMeetingRecording("workspace-a", "meeting-a", "speaker")).toBeNull();
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-a", meetingId: "meeting-a", status: "complete" },
      include: expect.objectContaining({ chunks: { where: { channel: "speaker" }, orderBy: { chunkIndex: "asc" }, select: { objectKey: true, byteLength: true } } }),
    }));
  });

  it("returns ordered channel chunks and their exact aggregate size without reading object storage", async () => {
    const chunks = [{ objectKey: "chunk-0", byteLength: 10 }, { objectKey: "chunk-1", byteLength: 25 }];
    findFirst.mockResolvedValue({ meeting: { title: "Quarterly review" }, chunks });
    expect(await findMeetingRecording("workspace-a", "meeting-a", "mic")).toEqual({
      title: "Quarterly review", chunks, totalBytes: 35,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-a", meetingId: "meeting-a", status: "complete" },
      orderBy: { createdAt: "desc" },
      include: {
        meeting: { select: { title: true } },
        chunks: { where: { channel: "mic" }, orderBy: { chunkIndex: "asc" }, select: { objectKey: true, byteLength: true } },
      },
    });
  });
});
