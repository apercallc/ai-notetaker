import { describe, expect, it, vi } from "vitest";
import { normalizeWebappUrl, testWebappHealth } from "../src/lib/providerTest";

describe("normalizeWebappUrl", () => {
  it("accepts only the canonical webapp root and removes fragments", () => {
    expect(normalizeWebappUrl("https://notes.example.com/#settings")).toBe("https://notes.example.com");
    expect(normalizeWebappUrl("https://notes.example.com/app/#settings")).toBeNull();
  });

  it("allows HTTP only for loopback development", () => {
    expect(normalizeWebappUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeWebappUrl("http://notes.example.com")).toBeNull();
  });

  it("rejects embedded credentials and non-web schemes", () => {
    expect(normalizeWebappUrl("https://user:pass@notes.example.com")).toBeNull();
    expect(normalizeWebappUrl("file:///tmp/notes")).toBeNull();
    expect(normalizeWebappUrl("not a url")).toBeNull();
  });
});

describe("testWebappHealth", () => {
  it("returns healthy when /api/health responds ok, with no auth header required", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://my-notes.example.com/api/health");
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await testWebappHealth("https://my-notes.example.com", fetchImpl);
    expect(result.healthy).toBe(true);
  });

  it("strips a trailing slash from the configured URL before checking health", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://my-notes.example.com/api/health");
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await testWebappHealth("https://my-notes.example.com/", fetchImpl);
  });

  it("reports unhealthy on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("dns failure");
    }) as unknown as typeof fetch;
    const result = await testWebappHealth("https://unreachable.example.com", fetchImpl);
    expect(result.healthy).toBe(false);
  });

  it("reports the remote HTTP status for an unhealthy deployment", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(testWebappHealth("https://notes.example.com", fetchImpl)).resolves.toEqual({
      healthy: false,
      message: "Webapp responded with HTTP 503.",
    });
  });

  it("passes an abort signal so a stalled health check cannot hang the settings page", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    await expect(testWebappHealth("https://notes.example.com", fetchImpl)).resolves.toEqual({
      healthy: true,
      message: "Connected to your self-hosted webapp.",
    });
  });
});
