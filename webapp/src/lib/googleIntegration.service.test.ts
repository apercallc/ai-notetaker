import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import {
  completeOAuthConnection,
  disconnectGoogle,
  exportMeetingToGoogleDrive,
  findCurrentGoogleCalendarEvent,
  googleConnectionStatus,
  googleOAuthConfigured,
} from "./googleIntegration";

const EMAIL = "google.batch.owner@example.com";
const USER_ID = "00000000-0000-4000-8000-000000009501";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000009502";
const MEETING_ID = "00000000-0000-4000-8000-000000009503";
const encryptionKey = Buffer.alloc(32, 19).toString("base64");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function createConnection(expiresIn = 3_600): Promise<void> {
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockResolvedValueOnce(response({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: expiresIn, scope: "calendar drive" }));
  fetch.mockResolvedValueOnce(response({ email: EMAIL }));
  await completeOAuthConnection(USER_ID, "authorization-code", { userId: USER_ID, state: "state", verifier: "pkce-verifier", expiresAt: Date.now() + 10_000 });
}

async function clean(): Promise<void> {
  await prisma.meeting.deleteMany({ where: { id: MEETING_ID } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

beforeEach(async () => {
  await clean();
  process.env.MANAGED_HOSTING = "false";
  process.env.APP_URL = "https://notetaker.example.test";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_OAUTH_ENCRYPTION_KEY = encryptionKey;
  vi.stubGlobal("fetch", vi.fn());
  await prisma.user.create({ data: { id: USER_ID, email: EMAIL, passwordHash: "test-hash" } });
});

afterAll(async () => {
  await clean();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

describe("server-owned Google credential exchange", () => {
  it("stores encrypted refresh credentials and reports only non-secret connection metadata", async () => {
    await createConnection();
    expect(googleOAuthConfigured()).toBe(true);
    expect(await googleConnectionStatus(USER_ID)).toEqual({ configured: true, connected: true, accountEmail: EMAIL });
    const stored = await prisma.googleOAuthConnection.findUniqueOrThrow({ where: { userId: USER_ID } });
    expect(stored.accessTokenCiphertext).not.toContain("access-secret");
    expect(stored.refreshTokenCiphertext).not.toContain("refresh-secret");
    expect(stored.scopes).toBe("calendar drive");
    expect(new URLSearchParams(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body)).get("code_verifier")).toBe("pkce-verifier");
    await disconnectGoogle(USER_ID);
    expect(await googleConnectionStatus(USER_ID)).toEqual({ configured: true, connected: false, accountEmail: null });
  });

  it("maps unreachable, rejected, malformed, and missing-refresh responses to safe reconnect errors", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockRejectedValueOnce(new Error("network secret")).mockResolvedValueOnce(response({}, 400));
    await expect(completeOAuthConnection(USER_ID, "code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 5_000 }))
      .rejects.toMatchObject({ publicMessage: "Google could not be reached. Try again." });
    await expect(completeOAuthConnection(USER_ID, "code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 5_000 }))
      .rejects.toMatchObject({ status: 400, publicMessage: "Google authorization was not accepted. Try connecting again." });

    fetch.mockResolvedValueOnce(response({ expires_in: 3_600 }));
    await expect(completeOAuthConnection(USER_ID, "code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 5_000 }))
      .rejects.toMatchObject({ publicMessage: "Google did not return usable authorization. Try connecting again." });

    fetch.mockResolvedValueOnce(response({ access_token: "access", expires_in: 3_600 }));
    await expect(completeOAuthConnection(USER_ID, "code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 5_000 }))
      .rejects.toMatchObject({ status: 400, publicMessage: "Google did not grant offline access. Remove the connection and try again." });
    expect(await prisma.googleOAuthConnection.findUnique({ where: { userId: USER_ID } })).toBeNull();
  });

  it("allows an absent userinfo email without storing provider response data in the browser contract", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(response({ access_token: "access", refresh_token: "refresh", expires_in: 3_600 }));
    fetch.mockResolvedValueOnce(response({ email: "x".repeat(321) }));
    await completeOAuthConnection(USER_ID, "code", { userId: USER_ID, state: "s", verifier: "v", expiresAt: Date.now() + 5_000 });
    expect((await googleConnectionStatus(USER_ID)).accountEmail).toBeNull();
  });
});

describe("disconnect and revoked access", () => {
  it("revokes the grant at Google before deleting the local copy, and still deletes if Google is unreachable", async () => {
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({}));
    await disconnectGoogle(USER_ID);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get("token")).toBe("refresh-secret");
    expect(await googleConnectionStatus(USER_ID)).toMatchObject({ connected: false });

    await createConnection();
    fetch.mockReset();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await disconnectGoogle(USER_ID);
    expect(await googleConnectionStatus(USER_ID)).toMatchObject({ connected: false });
  });

  it("asks the user to reconnect when Google reports the refresh grant as invalid", async () => {
    await createConnection(0);
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({ error: "invalid_grant" }, 400));
    await expect(findCurrentGoogleCalendarEvent(USER_ID)).rejects.toMatchObject({ status: 409, publicMessage: expect.stringContaining("Reconnect Google") });
  });
});

describe("current calendar event lookup", () => {
  it("ignores malformed and non-current events and returns a normalized active event", async () => {
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({ items: [
      { summary: "Broken", start: { dateTime: "not-a-date" }, end: { dateTime: "2026-09-27T15:00:00Z" } },
      { summary: "Later", start: { dateTime: "2026-09-27T16:00:00Z" }, end: { dateTime: "2026-09-27T17:00:00Z" } },
      {
        attendees: [{ displayName: "Sam" }, { email: "lee@example.com" }, {}],
        start: { dateTime: "2026-09-27T14:00:00Z" }, end: { dateTime: "2026-09-27T15:00:00Z" },
        conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "https://phone.example" }, { entryPointType: "video", uri: "https://meet.google.com/abc" }] },
      },
    ] }));
    const now = new Date("2026-09-27T14:30:00Z");
    expect(await findCurrentGoogleCalendarEvent(USER_ID, now)).toEqual({
      title: "", attendees: ["Sam", "lee@example.com"], startsAt: "2026-09-27T14:00:00Z", endsAt: "2026-09-27T15:00:00Z", meetUrl: "https://meet.google.com/abc",
    });
    const requestUrl = String(fetch.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("singleEvents=true");
    expect(requestUrl).toContain("orderBy=startTime");
  });

  it("refreshes credentials after an authorization rejection and safely retries once", async () => {
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({}, 401));
    fetch.mockResolvedValueOnce(response({ access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3_600, scope: "new scopes" }));
    fetch.mockResolvedValueOnce(response({ items: [{ summary: "Active", start: { dateTime: "2026-09-27T10:00:00Z" }, end: { dateTime: "2026-09-27T16:00:00Z" } }] }));
    const result = await findCurrentGoogleCalendarEvent(USER_ID, new Date("2026-09-27T14:30:00Z"));
    expect(result?.title).toBe("Active");
    expect(fetch).toHaveBeenCalledTimes(3);
    const stored = await prisma.googleOAuthConnection.findUniqueOrThrow({ where: { userId: USER_ID } });
    expect(stored.accessTokenCiphertext).not.toContain("refreshed-access");
    expect(stored.scopes).toBe("new scopes");
  });

  it("requires an existing connection and maps provider HTTP errors to safe messages", async () => {
    await expect(findCurrentGoogleCalendarEvent(USER_ID)).rejects.toMatchObject({ status: 409, publicMessage: "Google connection required." });
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({}, 403));
    await expect(findCurrentGoogleCalendarEvent(USER_ID)).rejects.toMatchObject({ publicMessage: "Google request failed. Try again." });
    fetch.mockReset();
    fetch.mockRejectedValueOnce(new Error("private provider detail"));
    await expect(findCurrentGoogleCalendarEvent(USER_ID)).rejects.toMatchObject({ publicMessage: "Google could not be reached. Try again." });
  });
});

describe("Google Drive meeting export", () => {
  it("reuses an existing app folder and writes the meeting content as a Google Doc", async () => {
    await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Google export workspace" } });
    await prisma.meeting.create({
      data: {
        id: MEETING_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, title: "Export review", mode: "general",
        startedAt: new Date("2026-09-27T14:00:00Z"), endedAt: new Date("2026-09-27T14:30:00Z"), summary: "Ship the safer flow.",
        transcript: { create: [{ userId: USER_ID, speaker: "Sam", text: "Let's ship it.", timestamp: new Date("2026-09-27T14:02:00Z"), order: 0 }] },
        actionItems: { create: [{ userId: USER_ID, text: "Ship it", owner: "Sam", status: "open", dueAt: new Date("2026-10-01T00:00:00Z") }] },
      },
    });
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({ files: [{ id: "existing-folder" }] }));
    fetch.mockResolvedValueOnce(response({ id: "document-1", webViewLink: "https://docs.google.com/document/d/document-1" }));
    expect(await exportMeetingToGoogleDrive(USER_ID, WORKSPACE_ID, MEETING_ID)).toEqual({
      fileId: "document-1", webViewLink: "https://docs.google.com/document/d/document-1",
    });
    // One folder lookup and one Drive upload. The Docs API, which needs the broad
    // documents scope, is never called.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => String(call[0])).some((url) => url.includes("docs.googleapis.com"))).toBe(false);
    const uploadUrl = String(fetch.mock.calls[1]?.[0]);
    expect(uploadUrl).toContain("https://www.googleapis.com/upload/drive/v3/files");
    expect(uploadUrl).toContain("uploadType=multipart");
    const uploadInit = fetch.mock.calls[1]?.[1];
    const contentType = String((uploadInit?.headers as Record<string, string>)["Content-Type"]);
    expect(contentType).toMatch(/^multipart\/related; boundary=/u);
    const [metadataPart, contentPart] = String(uploadInit?.body).split(`--${contentType.split("boundary=")[1]}`).map((part) => part.trim()).filter((part) => part && part !== "--");
    expect(JSON.parse(metadataPart.split("\r\n\r\n")[1])).toMatchObject({ name: "Export review — 2026-09-27", mimeType: "application/vnd.google-apps.document", parents: ["existing-folder"] });
    expect(contentPart).toContain("Content-Type: text/plain");
    expect(contentPart).toContain("Ship the safer flow.");
    expect(contentPart).toContain("- [open] Ship it (Sam) — due 2026-10-01");
    expect(contentPart).toContain("[2026-09-27T14:02:00.000Z] Sam: Let's ship it.");
  });

  it("checks configuration and completion before creating remote files, and rejects unusable Drive results", async () => {
    await expect(exportMeetingToGoogleDrive(USER_ID, WORKSPACE_ID, "x".repeat(129))).rejects.toMatchObject({ status: 400, publicMessage: "meetingId is required." });
    await expect(exportMeetingToGoogleDrive(USER_ID, WORKSPACE_ID, "missing-meeting")).rejects.toMatchObject({ status: 404, publicMessage: "Completed meeting not found." });

    await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Google export workspace" } });
    await prisma.meeting.create({
      data: { id: MEETING_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, title: "No folder id", startedAt: new Date("2026-09-27T14:00:00Z"), endedAt: new Date("2026-09-27T14:30:00Z"), summary: "" },
    });
    await createConnection();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockReset();
    fetch.mockResolvedValueOnce(response({ files: [] }));
    fetch.mockResolvedValueOnce(response({}));
    await expect(exportMeetingToGoogleDrive(USER_ID, WORKSPACE_ID, MEETING_ID)).rejects.toMatchObject({ status: 502, publicMessage: "Google Drive did not create an export folder." });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
