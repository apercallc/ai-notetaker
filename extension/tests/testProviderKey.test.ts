import { describe, expect, it, vi } from "vitest";
import { testProviderKeyDirect } from "../src/lib/testProviderKey";

describe("direct provider key validation", () => {
  it.each([
    ["deepgram", "api.deepgram.com", "Authorization", "Token secret"],
    ["groq", "api.groq.com", "Authorization", "Bearer secret"],
    ["claude", "api.anthropic.com", "x-api-key", "secret"],
    ["gemini", "generativelanguage.googleapis.com", "x-goog-api-key", "secret"],
    ["deepseek", "api.deepseek.com", "Authorization", "Bearer secret"],
  ] as const)("authenticates %s against the provider without exposing keys in URLs", async (provider, host, header, value) => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    expect((await testProviderKeyDirect(provider, " secret ", request)).valid).toBe(true);
    expect(request).toHaveBeenCalledWith(expect.stringContaining(host), expect.objectContaining({ method: "GET", headers: expect.objectContaining({ [header]: value }), signal: expect.any(AbortSignal) }));
    expect(String(request.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it.each([401, 403, 429, 503])("does not call HTTP %s a validated key", async (status) => {
    const request = vi.fn(async () => new Response("", { status }));
    expect((await testProviderKeyDirect("groq", "bad-key", request)).valid).toBe(false);
  });

  it("handles blank keys without a provider request", async () => {
    const request = vi.fn();
    expect((await testProviderKeyDirect("groq", " ", request)).valid).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
