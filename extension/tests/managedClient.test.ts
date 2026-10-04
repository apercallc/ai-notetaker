import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { exportManagedMeetingToGoogleDrive, getManagedEntitlements, loginManaged, loginManagedWithGoogle, ManagedAuthError, managedBillingUrl, managedIntegrationsUrl, managedSignupUrl, registerManagedMeeting, uploadManagedMeeting } from "../src/lib/managedClient";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("managedClient", () => {
  beforeEach(() => {
    chromeMock.reset();
    Object.defineProperty(chrome, "permissions", { configurable: true, value: chromeMock.permissions });
  });

  it("uploads directly without sharing credentials and verifies ambiguous PUT completion", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "secret-session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ uploadId: "u", directUpload: true }))
      .mockResolvedValueOnce(response({ url: "https://private.example.com/key?signature=signed", replayed: false }))
      .mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(response({ replayed: false }))
      .mockResolvedValueOnce(response({ status: "complete" }))
      .mockResolvedValueOnce(response({ jobId: "j" }));
    await expect(uploadManagedMeeting(config, "meeting", [{ index: 0, channel: "mic", bytes: new Uint8Array([1, 2]) }], fetchImpl)).resolves.toMatchObject({ jobId: "j" });
    const storageInit = fetchImpl.mock.calls[2]![1] as RequestInit;
    expect(storageInit.credentials).toBe("omit");
    expect(storageInit.redirect).toBe("error");
    expect(storageInit.headers).toEqual({ "Content-Type": "application/octet-stream", "If-None-Match": "*" });
    expect(fetchImpl.mock.calls[3]![0]).toContain("/chunks/0/direct");
    expect(fetchImpl.mock.calls[3]![1]!.body).toBe(JSON.stringify({ operation: "complete" }));
  });
  it("builds a safe hosted signup URL", () => {
    expect(managedSignupUrl("https://notes.example.com/")).toBe("https://notes.example.com/login?tab=signup");
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
    const permissions = chrome.permissions;
    const originalRequest = permissions.request;
    Object.defineProperty(permissions, "request", { configurable: true, value: request });
    try {
      await loginManaged("https://notes.example.com/path", "owner@example.com", "password", vi.fn().mockResolvedValue(response({ accessToken: "session", accountId: "acct", workspaceId: "ws" })));
      expect(request).toHaveBeenCalledWith({ origins: ["https://notes.example.com/*"] });
    } finally {
      Object.defineProperty(permissions, "request", { configurable: true, value: originalRequest });
    }
  });

  it("exchanges Google sign-in with a short-lived code and the PKCE verifier", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" }));
    const launchFlow = chrome.identity.launchWebAuthFlow as unknown as { mockImplementation: (implementation: (details: { url: string }, callback: (url?: string) => void) => void) => void };
    launchFlow.mockImplementation((details, callback) => {
      const start = new URL(details.url);
      callback(`${chrome.identity.getRedirectURL("hosted-auth")}#state=${start.searchParams.get("client_state")}&code=one-use-code`);
    });

    await expect(loginManagedWithGoogle("https://notes.example.com", fetchImpl)).resolves.toMatchObject({
      config: { accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" },
    });
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      permissions: ["identity"],
      origins: ["https://notes.example.com/*"],
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://notes.example.com/api/v1/auth/google/exchange", expect.objectContaining({
      method: "POST",
      body: expect.stringMatching(/^\{"code":"one-use-code","codeVerifier":"[A-Za-z0-9_-]+"\}$/u),
    }));
  });

  it("requests the optional identity permission before reading the Google identity API", async () => {
    const originalIdentity = Object.getOwnPropertyDescriptor(chrome, "identity");
    const originalRequest = Object.getOwnPropertyDescriptor(chrome.permissions, "request");
    let identityGranted = false;
    const identity = chromeMock.identity;
    const request = vi.fn(async () => {
      identityGranted = true;
      return true;
    });
    Object.defineProperty(chrome, "identity", {
      configurable: true,
      get: () => identityGranted ? identity : undefined,
    });
    Object.defineProperty(chrome.permissions, "request", { configurable: true, value: request });
    const fetchImpl = vi.fn().mockResolvedValue(response({ accessToken: "session", accountId: "acct", workspaceId: "ws" }));
    const launchFlow = identity.launchWebAuthFlow as unknown as { mockImplementation: (implementation: (details: { url: string }, callback: (url?: string) => void) => void) => void };
    launchFlow.mockImplementation(({ url }, callback) => {
      const start = new URL(url);
      callback(`${chrome.identity.getRedirectURL("hosted-auth")}#state=${start.searchParams.get("client_state")}&code=one-use-code`);
    });

    try {
      await expect(loginManagedWithGoogle("https://notes.example.com", fetchImpl)).resolves.toMatchObject({
        config: { accessToken: "session", accountId: "acct", workspaceId: "ws" },
      });
      expect(request).toHaveBeenCalledWith({
        permissions: ["identity"],
        origins: ["https://notes.example.com/*"],
      });
      expect(identity.launchWebAuthFlow).toHaveBeenCalledOnce();
    } finally {
      if (originalIdentity) Object.defineProperty(chrome, "identity", originalIdentity);
      if (originalRequest) Object.defineProperty(chrome.permissions, "request", originalRequest);
    }
  });

  it("rejects a mismatched Google OAuth state without exchanging a code", async () => {
    const fetchImpl = vi.fn();
    const launchFlow = chrome.identity.launchWebAuthFlow as unknown as { mockImplementation: (implementation: (details: { url: string }, callback: (url?: string) => void) => void) => void };
    launchFlow.mockImplementation((_details, callback) => {
      const redirect = chrome.identity.getRedirectURL("hosted-auth");
      callback(`${redirect}#state=wrong-state&code=one-use-code`);
    });
    await expect(loginManagedWithGoogle("https://notes.example.com", fetchImpl)).rejects.toThrow("could not be verified");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops Google sign-in if the user declines the required Chrome permission", async () => {
    (chrome.permissions.request as unknown as { mockResolvedValue: (value: boolean) => void }).mockResolvedValue(false);
    const fetchImpl = vi.fn();
    await expect(loginManagedWithGoogle("https://notes.example.com", fetchImpl)).rejects.toThrow("Allow access");
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads server-authoritative hosted quota before a recording starts", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    await expect(getManagedEntitlements(config, vi.fn().mockResolvedValue(response({
      plan: "hosted_pro", planLabel: "Hosted Pro", status: "active", used: 4, limit: 1_000,
      remaining: 996, warning: "low", audio: { remainingSeconds: 7_200, warning: "none" },
      canProcess: true, inPaymentGrace: false,
    })))).resolves.toEqual({
      planLabel: "Hosted Pro",
      plan: "hosted_pro",
      status: "active",
      used: 4,
      limit: 1_000,
      remaining: 996,
      warning: "low",
      audio: { remainingSeconds: 7_200, warning: "none" },
      canProcess: true,
      inPaymentGrace: false,
    });
  });

  it("keeps the Google Drive export call inside the authenticated hosted service", async () => {
    const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
    const driveFetch = vi.fn().mockResolvedValue(response({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" }, 201));
    await expect(exportManagedMeetingToGoogleDrive(config, "meeting-1", driveFetch)).resolves.toEqual({ fileId: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" });
    expect(driveFetch).toHaveBeenCalledWith("https://notes.example.com/api/v1/google/drive/export", expect.objectContaining({ method: "POST", body: JSON.stringify({ meetingId: "meeting-1" }) }));
  });

  it("explains an unreachable service and a throttled sign-in in plain words", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(loginManaged("https://notes.example.com", "a@b.test", "pw", offline)).rejects.toThrow("Could not reach the hosted service");

    const throttled = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "too many sign-in attempts, try again later" }), { status: 429, headers: { "retry-after": "600" } }));
    await expect(loginManaged("https://notes.example.com", "a@b.test", "pw", throttled)).rejects.toThrow("Try again in 10 minutes");
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
    const unauthorizedAgain = vi.fn().mockImplementation(async () => response({ error: "managed session required" }, 401));
    await expect(getManagedEntitlements(config, unauthorizedAgain)).rejects.toBeInstanceOf(ManagedAuthError);
  }, 10_000);

  it("keeps the request timeout active while parsing the response body and retries timed-out bodies", async () => {
    vi.useFakeTimers();
    try {
      const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
      const fetchImpl = vi.fn<typeof fetch>()
        .mockImplementationOnce((_input, init) => Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("expected an abort signal");
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
        } as Response))
        .mockResolvedValueOnce(response({ plan: "hosted_pro", status: "active", used: 0, limit: 1_000, remaining: 1_000, canProcess: true, inPaymentGrace: false }));

      const request = getManagedEntitlements(config, fetchImpl);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(250);
      await expect(request).resolves.toMatchObject({ canProcess: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries response body stream failures and clears the failed attempt timeout before backoff", async () => {
    vi.useFakeTimers();
    try {
      const config = { baseUrl: "https://notes.example.com", accessToken: "session", accountId: "acct", workspaceId: "ws", plan: "hosted_pro" };
      const firstResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockRejectedValue(new TypeError("response stream failed")),
      } as unknown as Response;
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(response({ plan: "hosted_pro", status: "active", used: 0, limit: 1_000, remaining: 1_000, canProcess: true, inPaymentGrace: false }));

      const request = getManagedEntitlements(config, fetchImpl);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      await expect(request).resolves.toMatchObject({ canProcess: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send hosted credentials when the origin permission is denied", async () => {
    const request = vi.fn().mockResolvedValue(false);
    const fetchImpl = vi.fn();
    const originalPermissions = chrome.permissions;
    Object.defineProperty(chrome, "permissions", { configurable: true, value: { request } });
    try {
      await expect(loginManaged("https://notes.example.com", "owner@example.com", "password", fetchImpl)).rejects.toThrow("Allow access");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(chrome, "permissions", { configurable: true, value: originalPermissions });
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
