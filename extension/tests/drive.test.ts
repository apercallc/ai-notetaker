import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { buildDriveAuthorizationUrl, connectGoogleDrive, exportMeetingToDrive } from "../src/lib/drive";
import type { MeetingRecord } from "../src/types";

const meeting: MeetingRecord = {
  id: "m1",
  title: "Weekly sync",
  startedAt: "2026-09-24T14:30:00.000Z",
  endedAt: "2026-09-24T15:00:00.000Z",
  transcript: [],
  summary: "Ship it.",
  actionItems: [],
  status: "complete",
};

beforeEach(() => chromeMock.reset());

describe("Google Drive export", () => {
  it("builds a least-privilege authorization URL", () => {
    const url = buildDriveAuthorizationUrl("client-1", "https://extension.test/callback", "challenge");
    expect(url).toContain("client_id=client-1");
    expect(url).toContain("drive.file");
    expect(url).toContain("code_challenge=challenge");
  });

  it("exchanges the OAuth code and returns a local-only connection", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation((options: { url: string }, callback: (url: string) => void) => {
      const state = new URL(options.url).searchParams.get("state");
      callback(`https://extension.test/callback?code=abc&state=${encodeURIComponent(state ?? "")}`);
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 }));

    const connection = await connectGoogleDrive("client-1", "secret", fetchImpl);
    expect(connection.clientId).toBe("client-1");
    expect(connection.accessToken).toBe("access");
    expect(connection.refreshToken).toBe("refresh");
    expect(fetchImpl).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
  });

  it("rejects an OAuth redirect with a mismatched state", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation((_options: unknown, callback: (url: string) => void) => {
      callback("https://extension.test/callback?code=abc&state=attacker");
    });
    await expect(connectGoogleDrive("client-1", undefined, vi.fn())).rejects.toThrow("state did not match");
  });

  it("reuses the deterministic root folder and creates a Google Doc with formatted notes", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: "folder-z" }, { id: "folder-a" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await exportMeetingToDrive(meeting, {
      clientId: "client-1",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    }, fetchImpl);

    expect(result).toEqual({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("ai-notetaker");
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      name: "Weekly sync — 2026-09-24",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder-a"],
    });
    expect(JSON.parse(fetchImpl.mock.calls[2]?.[1]?.body as string).requests[0].insertText.text).toContain("# Weekly sync");
  });

  it("creates the folder when the user has no existing root folder", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "folder-new" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "doc-2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await exportMeetingToDrive(meeting, {
      clientId: "client-1",
      accessToken: "access",
      expiresAt: Date.now() + 60_000,
    }, fetchImpl);

    expect(result.fileId).toBe("doc-2");
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({
      name: "ai-notetaker",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    });
  });

  it("surfaces provider failures without pretending export succeeded", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(exportMeetingToDrive(meeting, {
      clientId: "client-1",
      accessToken: "access",
      expiresAt: Date.now() + 60_000,
    }, fetchImpl)).rejects.toThrow("Drive request failed: 403");
  });
});
