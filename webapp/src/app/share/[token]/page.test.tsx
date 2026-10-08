import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSharedMeeting, ipHeaders } = vi.hoisted(() => ({ getSharedMeeting: vi.fn(), ipHeaders: { current: { "x-forwarded-for": "203.0.113.9" } as Record<string, string> } }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers(ipHeaders.current)) }));
vi.mock("@/lib/sharing", () => ({ getSharedMeeting }));

import { shareLookupLimiter } from "@/lib/lookupThrottle";
import SharedMeetingPage from "./page";

const render = async (token: string) => renderToStaticMarkup(await SharedMeetingPage({ params: Promise.resolve({ token }) }));

const meeting = {
  title: "Roadmap sync",
  mode: "general",
  startedAt: "2026-09-24T10:00:00.000Z",
  endedAt: "2026-09-24T10:30:00.000Z",
  summary: "## Decisions\n- Ship it",
  transcript: [],
  actionItems: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  shareLookupLimiter.clear();
  ipHeaders.current = { "x-forwarded-for": "203.0.113.9" };
});

describe("public share page", () => {
  it("shows a live shared meeting", async () => {
    getSharedMeeting.mockResolvedValue(meeting);
    const html = await render("good-token");
    expect(html).toContain("Roadmap sync");
    expect(html).toContain("Ship it");
  });

  it("says expired or revoked for a token that opens nothing", async () => {
    getSharedMeeting.mockResolvedValue(null);
    expect(await render("dead-token")).toContain("expired or was revoked");
  });

  it("tells an over-limit reader to wait, without claiming the link is dead", async () => {
    getSharedMeeting.mockResolvedValue(meeting);
    for (let hit = 0; hit < 60; hit += 1) await render("good-token");
    const html = await render("good-token");
    expect(html).toContain("Too many requests");
    expect(html).not.toContain("expired or was revoked");
    expect(getSharedMeeting).toHaveBeenCalledTimes(60);
  });

  it("does not throttle readers whose IP is unknown, so they cannot starve each other", async () => {
    ipHeaders.current = {};
    getSharedMeeting.mockResolvedValue(meeting);
    for (let hit = 0; hit < 70; hit += 1) expect(await render("good-token")).not.toContain("Too many requests");
    expect(getSharedMeeting).toHaveBeenCalledTimes(70);
  });
});
