import { beforeEach, describe, expect, it, vi } from "vitest";

const hosting = vi.hoisted(() => ({ enabled: true }));
const askNotes = vi.hoisted(() => vi.fn());
const listFolders = vi.hoisted(() => vi.fn());

vi.mock("@/lib/managedAuth", () => ({ managedHostingEnabled: () => hosting.enabled }));
vi.mock("@/lib/library", () => ({ listFolders }));
vi.mock("@/lib/notesChat", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notesChat")>()), askNotes }));

const { askWorkspaceNotes } = await import("./askRunner");
const { ChatBusyError, ChatProviderError, InvalidQuestionError } = await import("@/lib/notesChat");
const { ChatUnavailableError } = await import("@/lib/chatQuota");

const answer = { answer: "Ship it.", sources: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  hosting.enabled = true;
  listFolders.mockResolvedValue([{ id: "root", parentId: null }, { id: "child", parentId: "root" }]);
  askNotes.mockResolvedValue(answer);
});

describe("askWorkspaceNotes", () => {
  it("is unavailable outside the hosted service", async () => {
    hosting.enabled = false;
    expect(await askWorkspaceNotes("w1", "q")).toEqual({ ok: false, error: "Ask your notes is available on the hosted service." });
    expect(askNotes).not.toHaveBeenCalled();
  });

  it("answers across the whole library without a folder", async () => {
    expect(await askWorkspaceNotes("w1", "What was decided?")).toEqual({ ok: true, ...answer });
    expect(askNotes).toHaveBeenCalledWith("w1", "What was decided?", undefined);
  });

  it("scopes a question to a folder and the folders inside it", async () => {
    await askWorkspaceNotes("w1", "q", "root");
    expect(askNotes).toHaveBeenCalledWith("w1", "q", expect.arrayContaining(["root", "child"]));
  });

  it("refuses a folder that is no longer in the library", async () => {
    const result = await askWorkspaceNotes("w1", "q", "gone");
    expect(result.ok).toBe(false);
    expect(askNotes).not.toHaveBeenCalled();
  });

  it("treats a non-string question as empty", async () => {
    await askWorkspaceNotes("w1", 42 as unknown as string);
    expect(askNotes).toHaveBeenCalledWith("w1", "", undefined);
  });

  it.each([
    ["an invalid question", new InvalidQuestionError("Ask a question.")],
    ["a busy assistant", new ChatBusyError()],
    ["an exhausted quota", new ChatUnavailableError("limit")],
  ])("returns the message for %s", async (_name, error) => {
    askNotes.mockRejectedValue(error);
    expect(await askWorkspaceNotes("w1", "q")).toEqual({ ok: false, error: error.message });
  });

  it("hides provider and unexpected failures behind a plain message", async () => {
    askNotes.mockRejectedValueOnce(new ChatProviderError("upstream 500"));
    expect(await askWorkspaceNotes("w1", "q")).toMatchObject({ ok: false, error: expect.stringContaining("not charged") });
    askNotes.mockRejectedValueOnce(new Error("db down"));
    expect(await askWorkspaceNotes("w1", "q")).toMatchObject({ ok: false, error: expect.stringContaining("Something went wrong") });
  });
});
