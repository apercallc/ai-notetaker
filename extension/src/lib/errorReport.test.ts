import { afterEach, describe, expect, it, vi } from "vitest";
import { reportManagedError } from "./errorReport";

describe("managed error telemetry privacy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a stable failure label without provider text, stack, meeting ID, or token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    reportManagedError(
      { baseUrl: "https://managed.example.test", accessToken: "private-access-token", workspaceId: "private-workspace", accountId: "private-account", plan: "pro" },
      new Error("provider body: private transcript https://signed.example.test?token=secret"),
      {
        surface: "managed_upload",
        key: "privacy-regression-1",
        meetingId: "private-meeting-id",
        extensionVersion: "1.2.3",
        fetchImpl,
      },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const call = fetchImpl.mock.calls.at(0);
    expect(call).toBeDefined();
    const [, init] = call!;
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      message: "managed_upload operation failed",
      surface: "managed_upload",
      errorClass: "Error",
      extensionVersion: "1.2.3",
    });
    expect(JSON.stringify(body)).not.toMatch(/private|secret|token|transcript/);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer private-access-token" });
  });

  it("never sends the bearer token to an insecure or malformed service URL", () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    for (const [index, baseUrl] of ["http://evil.example.test", "not a url", "https://user:pw@managed.example.test"].entries()) {
      reportManagedError(
        { baseUrl, accessToken: "private-access-token", workspaceId: "w", accountId: "a", plan: "pro" },
        new Error("x"),
        { surface: "managed_upload", key: `bad-url-${index}`, fetchImpl },
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
