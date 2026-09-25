import { describe, expect, it, vi } from "vitest";
import { exportManagedMeetingToGoogleDrive, getManagedEntitlements, getManagedGoogleCalendarEvent, loginManaged, managedBillingUrl, managedIntegrationsUrl, managedSignupUrl, registerManagedMeeting, uploadManagedMeeting } from "../src/lib/managedClient";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("managedClient", () => {
  it("builds a safe hosted signup URL", () => {
    expect(managedSignupUrl("https://notes.example.com/")).toBe("https://notes.example.com/login?mode=signup");
    expect(() => managedSignupUrl("http://notes.example.com")).toThrow("HTTPS");
  });

  it("builds billing and account-integration links only for valid hosted service URLs", () => {
    expect(managedBillingUrl("https://notes.example.com/workspace/")).toBe("https://notes.example.com/workspace/billing");
    expect(managedIntegrationsUrl("https://notes.example.com/workspace/")).toBe("https://notes.example.com/workspace/account#google-services");
    expect(() => managedBillingUrl("javascript:alert(1)")).toThrow("HTTPS");
  });

  it("logs in without returning provider credentials to the caller", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" }));
    const result = await loginManaged("https://notes.example.com", "owner@example.com", "password", fetchImpl);
    expect(result.config).toEqual({ baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" });
    expect(fetchImpl).toHaveBeenCalledWith("https://notes.example.com/api/v1/auth/login", expect.objectContaining({ method: "POST" }));
  });

  it("requests only the hosted service origin when Chrome exposes optional permissions", async () => {
    const request = vi.fn().mockResolvedValue(true);
    Object.defineProperty(chrome, "permissions", { configurable: true, value: { request } });
    try {
      await loginManaged("https://notes.example.com/path", "owner@example.com", "password", vi.fn().mockResolvedValue(response({ accessToken: "session", accountId: "acct", workspaceId: "ws" })));
      expect(request).toHaveBeenCalledWith({ origins: ["https://notes.example.com/*"] });
    } finally {
      delete (chrome as unknown as { permissions?: unknown }).permissions;
    }
  });

  it("reads server-authoritative hosted quota before a recording starts", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    await expect(getManagedEntitlements(config, vi.fn().mockResolvedValue(response({ plan: "hosted_pro", status: "active", used: 4, limit: 1_000, remaining: 996, canProcess: true, inPaymentGrace: false })))).resolves.toEqual({
      plan: "hosted_pro",
      status: "active",
      used: 4,
      limit: 1_000,
      remaining: 996,
      canProcess: true,
      inPaymentGrace: false,
    });
  });

  it("keeps Google event and Drive export calls inside the authenticated hosted service", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    const calendarFetch = vi.fn().mockResolvedValue(response({ event: {
      title: "Weekly sync", attendees: ["Ava"], startsAt: "2026-09-25T15:00:00.000Z", endsAt: "2026-09-25T15:30:00.000Z",
    } }));
    await expect(getManagedGoogleCalendarEvent(config, calendarFetch)).resolves.toEqual({
      title: "Weekly sync", attendees: ["Ava"], startsAt: "2026-09-25T15:00:00.000Z", endsAt: "2026-09-25T15:30:00.000Z",
    });
    expect(calendarFetch).toHaveBeenCalledWith("https://notes.example.com/api/v1/google/calendar/current", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer session" }) }));

    const driveFetch = vi.fn().mockResolvedValue(response({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" }, 201));
    await expect(exportManagedMeetingToGoogleDrive(config, "meeting-1", driveFetch)).resolves.toEqual({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" });
    expect(driveFetch).toHaveBeenCalledWith("https://notes.example.com/api/v1/google/drive/export", expect.objectContaining({ method: "POST", body: JSON.stringify({ meetingId: "meeting-1" }) }));
  });

  it("retries transient hosted failures but does not retry authentication failures", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(response({ plan: "hosted_pro", status: "active", used: 0, limit: 1_000, remaining: 1_000, canProcess: true, inPaymentGrace: false }));
    await expect(getManagedEntitlements(config, fetchImpl)).resolves.toMatchObject({ canProcess: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const unauthorized = vi.fn().mockResolvedValue(response({ error: "managed session required" }, 401));
    await expect(getManagedEntitlements(config, unauthorized)).rejects.toThrow("managed session required");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("does not send hosted credentials when the origin permission is denied", async () => {
    const request = vi.fn().mockResolvedValue(false);
    const fetchImpl = vi.fn();
    Object.defineProperty(chrome, "permissions", { configurable: true, value: { request } });
    try {
      await expect(loginManaged("https://notes.example.com", "owner@example.com", "password", fetchImpl)).rejects.toThrow("Allow access");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      delete (chrome as unknown as { permissions?: unknown }).permissions;
    }
  });

  it("uploads chunks with checksums, completes the manifest, and queues one job", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ uploadId: "upload-1" }))
      .mockResolvedValueOnce(response({ ok: true }, 201))
      .mockResolvedValueOnce(response({ status: "complete" }))
      .mockResolvedValueOnce(response({ jobId: "job-1" }, 202));
    const result = await uploadManagedMeeting(
      { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
      "meeting-1",
      [{ channel: "speaker", index: 0, bytes: new Uint8Array([1, 2, 3, 4]) }],
      fetchImpl,
    );
    expect(result).toEqual({ uploadId: "upload-1", jobId: "job-1", meetingId: "meeting-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "X-Workspace-Id": "ws" }) }));
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "x-chunk-sha256": expect.any(String) }) }));
  });

  it("registers the meeting before its managed upload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ id: "meeting-1" }, 201));
    await registerManagedMeeting(
      { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
      {
        id: "meeting-1",
        title: "Weekly sync",
        startedAt: "2026-09-24T15:00:00.000Z",
        endedAt: null,
        transcript: [],
        summary: null,
        actionItems: [],
        status: "processing",
        mode: "general",
      },
      "2026-09-24T15:30:00.000Z",
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://notes.example.com/api/v1/meetings", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ id: "meeting-1", endedAt: "2026-09-24T15:30:00.000Z", captureSource: "meet", processingMode: "managed" });
  });

  it("requeues a completed upload without replaying chunks", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ uploadId: "upload-1", status: "complete" }))
      .mockResolvedValueOnce(response({ jobId: "job-2" }, 202));
    await expect(uploadManagedMeeting(
      { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
      "meeting-1",
      [{ channel: "speaker", index: 0, bytes: new Uint8Array([1, 2, 3]) }],
      fetchImpl,
    )).resolves.toMatchObject({ uploadId: "upload-1", jobId: "job-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("/process");
  });

  it("rejects non-HTTPS managed services except local development", async () => {
    await expect(loginManaged("http://notes.example.com", "a", "b", vi.fn())).rejects.toThrow("HTTPS");
  });
});
