import { describe, expect, it, vi, beforeEach } from "vitest";
import { chromeMock } from "./setup";
import { generatePkcePair, connectCalendar, findCurrentEvent, type CalendarConnection } from "../src/lib/calendar";

beforeEach(() => chromeMock.reset());

describe("generatePkcePair", () => {
  it("produces a verifier and a distinct S256 challenge", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
    // base64url alphabet only, no padding
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a different verifier each call", async () => {
    const first = await generatePkcePair();
    const second = await generatePkcePair();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe("connectCalendar", () => {
  it("launches the auth flow, exchanges the code, and returns a connection", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation(
      (_details: unknown, callback: (url?: string) => void) => {
        callback("https://fake-extension-id.chromiumapp.org/?code=fake-auth-code");
      },
    );
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
    })) as unknown as typeof fetch;

    const connection = await connectCalendar("google", "client-id", "client-secret", fetchImpl);

    expect(connection.provider).toBe("google");
    expect(connection.accessToken).toBe("access-1");
    expect(connection.refreshToken).toBe("refresh-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects when the auth flow returns no code", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation(
      (_details: unknown, callback: (url?: string) => void) => {
        callback("https://fake-extension-id.chromiumapp.org/?error=access_denied");
      },
    );
    await expect(connectCalendar("google", "client-id", "client-secret", vi.fn() as unknown as typeof fetch)).rejects.toThrow();
  });

  it("rejects when the auth flow is cancelled", async () => {
    chromeMock.identity.launchWebAuthFlow.mockImplementation(
      (_details: unknown, callback: (url?: string) => void) => {
        callback(undefined);
      },
    );
    await expect(connectCalendar("google", "client-id", "client-secret", vi.fn() as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("findCurrentEvent", () => {
  const baseConnection: CalendarConnection = {
    provider: "google",
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "stale-access-token",
    refreshToken: "refresh-1",
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
  };

  it("refreshes an expired token before fetching events", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "fresh-token", expires_in: 3600 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              summary: "Team sync",
              attendees: [{ displayName: "Alex", email: "alex@example.com" }],
              start: { dateTime: new Date(Date.now() - 60_000).toISOString() },
              end: { dateTime: new Date(Date.now() + 60_000).toISOString() },
            },
          ],
        }),
      });

    const event = await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
    expect(event?.title).toBe("Team sync");
    expect(event?.attendees).toEqual(["Alex"]);
  });

  it("returns null when no event contains the current time", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "fresh-token", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    expect(await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null (never throws) when the refresh call fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    expect(await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null (never throws) when the events fetch rejects outright", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    expect(await findCurrentEvent(baseConnection, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("does not refresh a still-valid token", async () => {
    const validConnection = { ...baseConnection, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    await findCurrentEvent(validConnection, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses an Outlook event response shape", async () => {
    const outlookConnection: CalendarConnection = { ...baseConnection, provider: "outlook", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [
          {
            subject: "Standup",
            attendees: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
            start: { dateTime: new Date(Date.now() - 60_000).toISOString() },
            end: { dateTime: new Date(Date.now() + 60_000).toISOString() },
          },
        ],
      }),
    });
    const event = await findCurrentEvent(outlookConnection, fetchImpl as unknown as typeof fetch);
    expect(event?.title).toBe("Standup");
    expect(event?.attendees).toEqual(["Sam"]);
  });
});
