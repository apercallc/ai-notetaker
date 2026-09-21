import { describe, expect, it, vi } from "vitest";
import { testWebappHealth } from "../src/lib/providerTest";

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
});
