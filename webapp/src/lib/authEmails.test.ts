import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const sender = vi.hoisted(() => ({ current: null as null | { mode: "resend" | "console"; send: ReturnType<typeof vi.fn> } }));
const issueAuthToken = vi.hoisted(() => vi.fn(async () => ({ token: "opaque + token", expiresAt: new Date("2026-09-28T00:00:00Z") })));

vi.mock("./authTokens", () => ({ issueAuthToken }));
vi.mock("./mailer", () => ({ getEmailSender: () => sender.current }));

import { sendInviteEmail, sendPasswordResetEmail, sendVerificationEmail } from "./authEmails";

const prior = {
  appUrl: process.env.APP_URL,
  publicAppUrl: process.env.NEXT_PUBLIC_APP_URL,
};

beforeEach(() => {
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  sender.current = null;
  issueAuthToken.mockClear();
});

afterAll(() => {
  if (prior.appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = prior.appUrl;
  if (prior.publicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = prior.publicAppUrl;
});

describe("auth email links", () => {
  it("shows a development verification link using a validated request host", async () => {
    const result = await sendVerificationEmail({
      userId: "user-1",
      email: " Person@Example.com ",
      context: { protocol: "https", host: "notes.example.com" },
    });
    expect(issueAuthToken).toHaveBeenCalledWith(expect.objectContaining({ purpose: "verify_email", userId: "user-1", email: "person@example.com" }));
    expect(result).toEqual({ link: "https://notes.example.com/login?tab=verify&token=opaque%20%2B%20token", delivered: false });
  });

  it("uses operator configured origin for reset mail instead of the request host", async () => {
    process.env.APP_URL = "https://app.example.com/base-path";
    sender.current = { mode: "resend", send: vi.fn().mockResolvedValue(undefined) };
    const result = await sendPasswordResetEmail({
      userId: "user-1",
      email: "person@example.com",
      issuedByOwner: true,
      context: { protocol: "http", host: "attacker.example" },
    });
    expect(result.link).toBe("https://app.example.com/login?tab=reset&token=opaque%20%2B%20token");
    expect(sender.current.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "person@example.com",
      subject: "Reset your AI Notetaker password",
      text: expect.stringContaining("A workspace owner requested a password reset"),
    }));
    expect(sender.current.send.mock.calls[0]?.[0].text).toContain("https://app.example.com/login?tab=reset");
    expect(result.delivered).toBe(true);
  });

  it("withholds real delivery when there is no trusted app URL and rejects hostile request hosts", async () => {
    sender.current = { mode: "resend", send: vi.fn() };
    const badHost = await sendVerificationEmail({ userId: "user-1", email: "person@example.com", context: { protocol: "https", host: "victim.example\n.evil" } });
    expect(badHost.link).toBe("/login?tab=verify&token=opaque%20%2B%20token");
    expect(badHost.delivered).toBe(false);
    expect(sender.current.send).not.toHaveBeenCalled();
  });

  it("reports transport failure without exposing the emailed link as delivered", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://public.example.com/path";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sender.current = { mode: "resend", send: vi.fn().mockRejectedValue(new Error("provider down")) };
    try {
      const result = await sendInviteEmail({
        workspaceId: "workspace-1",
        workspaceName: "Engineering",
        email: "New.Member@example.com",
        role: "member",
        invitedById: "owner-1",
        invitedByEmail: "owner@example.com",
        context: { protocol: "http", host: "localhost:3000" },
      });
      expect(issueAuthToken).toHaveBeenCalledWith(expect.objectContaining({ purpose: "invite", email: "new.member@example.com", role: "member" }));
      expect(result.link).toBe("https://public.example.com/login?tab=invite&token=opaque%20%2B%20token");
      expect(result.delivered).toBe(false);
      expect(log).toHaveBeenCalledWith("auth email delivery failed", expect.objectContaining({ kind: "invite", error: "provider down" }));
    } finally {
      log.mockRestore();
    }
  });

  it("allows console links on a valid request origin but never claims that mail was sent", async () => {
    sender.current = { mode: "console", send: vi.fn().mockResolvedValue(undefined) };
    const result = await sendPasswordResetEmail({ userId: "user-1", email: "person@example.com", context: { protocol: "http", host: "127.0.0.1:3000" } });
    expect(sender.current.send).toHaveBeenCalledOnce();
    expect(result.link).toContain("http://127.0.0.1:3000/login?tab=reset");
    expect(result.delivered).toBe(false);
  });
});
