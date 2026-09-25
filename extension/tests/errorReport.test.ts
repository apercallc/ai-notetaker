import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportManagedError } from "../src/lib/errorReport";
import type { ManagedServiceConfig } from "../src/types";

const config: ManagedServiceConfig = {
  baseUrl: "https://hosted.example.com",
  accessToken: "session-token",
  accountId: "account-1",
  workspaceId: "workspace-1",
  plan: "pro",
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(): FetchLike & { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const impl: FetchLike = (input, init) => {
    calls.push([String(input), (init ?? {}) as RequestInit]);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const fn = impl as FetchLike & { calls: Array<[string, RequestInit]> };
  fn.calls = calls;
  return fn;
}

function rejectingFetch(): FetchLike {
  return () => Promise.reject(new Error("network down"));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reportManagedError", () => {
  it("sends a bounded report to the authenticated client-errors endpoint", () => {
    const fetchImpl = mockFetch();
    reportManagedError(config, new Error("upload failed"), { surface: "managed_upload", meetingId: "m1", extensionVersion: "0.1.0", fetchImpl });
    expect(fetchImpl.calls.length).toBe(1);
    const [url, init] = fetchImpl.calls[0]!;
    expect(url).toBe("https://hosted.example.com/api/v1/client-errors");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.message).toBe("upload failed");
    expect(body.surface).toBe("managed_upload");
    expect(body.meetingId).toBe("m1");
  });

  it("is a strict no-op without a managed service config (local BYOK telemetry boundary)", () => {
    const fetchImpl = mockFetch();
    reportManagedError(null, new Error("boom"), { surface: "meet_capture", fetchImpl });
    reportManagedError(undefined, new Error("boom"), { surface: "popup", fetchImpl });
    expect(fetchImpl.calls.length).toBe(0);
  });

  it("does not throw when the report request itself fails", () => {
    expect(() => reportManagedError(config, new Error("boom"), { surface: "widget", fetchImpl: rejectingFetch() })).not.toThrow();
  });

  it("deduplicates identical reports within the window and re-allows after it", () => {
    const fetchImpl = mockFetch();
    reportManagedError(config, new Error("same failure"), { surface: "managed_job", fetchImpl });
    reportManagedError(config, new Error("same failure"), { surface: "managed_job", fetchImpl });
    expect(fetchImpl.calls.length).toBe(1);
    vi.advanceTimersByTime(6 * 60_000);
    reportManagedError(config, new Error("same failure"), { surface: "managed_job", fetchImpl });
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("truncates oversized messages and stacks", () => {
    const fetchImpl = mockFetch();
    reportManagedError(config, new Error("x".repeat(2_000)), { surface: "background", fetchImpl });
    const body = JSON.parse(fetchImpl.calls[0]![1].body as string) as { message: string };
    expect(body.message.length).toBe(500);
  });
});
