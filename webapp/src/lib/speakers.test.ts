import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db";
import { getMeeting } from "./meetings";
import { retrieveNotes } from "./notesChat";
import { regenerateNotes } from "./notesRegenerate";
import { createMeetingShare, getSharedMeeting } from "./sharing";
import { getSpeakerNames, renameSpeaker, replaceLabel, validateSpeakerName } from "./speakers";
import { speakerLabel } from "./types";

describe("replaceLabel", () => {
  it("replaces whole words only", () => {
    expect(replaceLabel("Them 1 and Them 10 agreed; Them 1 left.", "Them 1", "Sam")).toBe("Sam and Them 10 agreed; Sam left.");
    expect(replaceLabel("Samuel met Sam.", "Sam", "Dana")).toBe("Samuel met Dana.");
  });

  it("matches possessives and punctuation but not inside other words", () => {
    expect(replaceLabel("Sam's plan, (Sam) said: Sam.", "Sam", "Dana")).toBe("Dana's plan, (Dana) said: Dana.");
    expect(replaceLabel("Samba", "Sam", "Dana")).toBe("Samba");
  });

  it("is safe with regex characters and replacement patterns in either name", () => {
    expect(replaceLabel("Dr. Ng spoke.", "Dr. Ng", "$& Lee")).toBe("$& Lee spoke.");
    expect(replaceLabel("A+B spoke.", "A+B", "Pat")).toBe("Pat spoke.");
  });

  it("works with non-ASCII names", () => {
    expect(replaceLabel("Zoë said hi; Zoëy left.", "Zoë", "Mia")).toBe("Mia said hi; Zoëy left.");
  });

  it("does nothing for an empty or unchanged label", () => {
    expect(replaceLabel("text", "", "x")).toBe("text");
    expect(replaceLabel("Sam", "Sam", "Sam")).toBe("Sam");
  });
});

describe("validateSpeakerName", () => {
  it("collapses whitespace and accepts ordinary names", () => {
    expect(validateSpeakerName("  Sam   Rivera ")).toEqual({ name: "Sam Rivera" });
  });

  it("rejects too short, too long, and markdown-structural names", () => {
    for (const bad of ["", "S", "x".repeat(61), "## Heading", "a*b", "a`b", "<b>", "a|b", "a]b", "a\\b"]) {
      expect(validateSpeakerName(bad)).toHaveProperty("error");
    }
  });
});

describe("renaming speakers", () => {
  const STARTED_AT = new Date("2026-09-24T15:00:00.000Z");
  const userId = "speakers-user";
  const saved: Record<string, string | undefined> = {};
  let workspaceId: string;
  let otherWorkspaceId: string;
  let meetingId: string;

  beforeEach(async () => {
    for (const name of ["MANAGED_HOSTING", "MANAGED_SUMMARY_PROVIDER", "MANAGED_OPENAI_API_KEY"]) saved[name] = process.env[name];
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    meetingId = randomUUID();
    await prisma.workspace.createMany({ data: [{ id: workspaceId, name: "Speakers workspace" }, { id: otherWorkspaceId, name: "Other speakers workspace" }] });
    await prisma.meeting.create({
      data: {
        id: meetingId, userId, workspaceId, title: "Kickoff", processingMode: "managed", startedAt: STARTED_AT, endedAt: new Date(STARTED_AT.getTime() + 60_000),
        summary: "You asked Them 1 about onboarding. Them 10 joined late. Them 2 will send the plan.\n\n## Decisions\n- Them 1 owns onboarding",
        transcript: { create: [
          { userId, speaker: "you", text: "How is onboarding?", timestamp: new Date(STARTED_AT.getTime() + 1_000), order: 0 },
          { userId, speaker: "them-1", text: "We need faster onboarding.", timestamp: new Date(STARTED_AT.getTime() + 5_000), order: 1 },
          { userId, speaker: "them-2", text: "I'll send the plan.", timestamp: new Date(STARTED_AT.getTime() + 9_000), order: 2 },
        ] },
        actionItems: { create: [
          { userId, text: "Them 2 to send the plan", owner: "Them 2" },
          { userId, text: "Review onboarding", owner: "you" },
          { userId, text: "Unrelated task", owner: null },
        ] },
      },
    });
  });

  afterEach(async () => {
    await prisma.meeting.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("renames a speaker across the summary, action items and the meeting view, leaving transcript keys alone", async () => {
    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "Sam Rivera")).toEqual({ ok: true, label: "Sam Rivera" });

    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId }, include: { transcript: { orderBy: { order: "asc" } }, actionItems: true } });
    expect(meeting.summary).toContain("You asked Sam Rivera about onboarding. Them 10 joined late. Them 2 will send the plan.");
    expect(meeting.summary).toContain("- Sam Rivera owns onboarding");
    expect(meeting.transcript.map((line) => line.speaker)).toEqual(["you", "them-1", "them-2"]);
    const detail = await getMeeting(workspaceId, meetingId);
    expect(detail?.speakerNames).toEqual({ "them-1": "Sam Rivera" });
    expect(speakerLabel("them-1", detail?.speakerNames)).toBe("Sam Rivera");
    expect(speakerLabel("them-2", detail?.speakerNames)).toBe("Them 2");
    expect(meeting.actionItems.find((item) => item.text.startsWith("Review"))!.owner).toBe("you");
  });

  it("renames the owner and text of action items that name the speaker", async () => {
    await renameSpeaker(workspaceId, meetingId, "them-2", "Priya");
    const items = await prisma.actionItem.findMany({ where: { meetingId } });
    expect(items.find((item) => item.text.includes("send the plan"))).toMatchObject({ text: "Priya to send the plan", owner: "Priya" });
    expect(items.find((item) => item.text === "Unrelated task")).toMatchObject({ owner: null });
  });

  it("replaces the previous name on a second rename and restores the default on reset", async () => {
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    await renameSpeaker(workspaceId, meetingId, "them-1", "Samantha");
    let summary = (await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).summary;
    expect(summary).toContain("You asked Samantha about onboarding");
    expect(summary).not.toContain("Sam about");

    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "")).toEqual({ ok: true, label: "Them 1" });
    summary = (await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).summary;
    expect(summary).toContain("You asked Them 1 about onboarding");
    expect(await getSpeakerNames(workspaceId, meetingId)).toEqual({});
    // Typing the default label also counts as a reset.
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "Them 1")).toEqual({ ok: true, label: "Them 1" });
    expect(await prisma.meetingSpeaker.count({ where: { meetingId } })).toBe(0);
  });

  it("names the recorder too", async () => {
    await renameSpeaker(workspaceId, meetingId, "you", "Dana");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).summary).toContain("Dana asked Them 1");
    expect((await prisma.actionItem.findFirstOrThrow({ where: { meetingId, text: "Review onboarding" } })).owner).toBe("Dana");
  });

  it("refuses duplicate names, including another speaker's default label, ignoring case", async () => {
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    expect(await renameSpeaker(workspaceId, meetingId, "them-2", "sam")).toEqual({ ok: false, error: "Another speaker already has that name." });
    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "Them 2")).toEqual({ ok: false, error: "Another speaker already has that name." });
    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "Sam")).toEqual({ ok: true, label: "Sam" }); // unchanged is fine
  });

  it("refuses speakers that are not in the transcript, bad names and other workspaces", async () => {
    expect(await renameSpeaker(workspaceId, meetingId, "them-9", "Sam")).toMatchObject({ ok: false });
    expect(await renameSpeaker(workspaceId, meetingId, "them-1", "## x")).toMatchObject({ ok: false });
    expect(await renameSpeaker(otherWorkspaceId, meetingId, "them-1", "Sam")).toEqual({ ok: false, error: "This meeting no longer exists." });
    expect(await prisma.meetingSpeaker.count({ where: { meetingId } })).toBe(0);
  });

  it("keeps both results when two speakers are renamed at once", async () => {
    await Promise.all([renameSpeaker(workspaceId, meetingId, "them-1", "Sam"), renameSpeaker(workspaceId, meetingId, "them-2", "Priya")]);
    const summary = (await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).summary;
    expect(summary).toContain("You asked Sam about onboarding. Them 10 joined late. Priya will send the plan.");
  });

  it("shows names on shared links without exposing internal processing fields", async () => {
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    const share = await createMeetingShare(workspaceId, meetingId);
    const shared = await getSharedMeeting(share.token);
    expect(shared?.speakerNames).toEqual({ "them-1": "Sam" });
    expect(shared).not.toHaveProperty("processingMode");
    expect(shared).not.toHaveProperty("notesRegenerations");
    expect(shared).not.toHaveProperty("processing");
  });

  it("uses the names in Ask your notes evidence", async () => {
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    const sources = await retrieveNotes(workspaceId, "faster onboarding");
    const excerpt = sources.find((source) => source.id === meetingId)?.excerpts.find((line) => line.text.includes("faster onboarding"));
    expect(excerpt?.speaker).toBe("Sam");
  });

  it("writes the chosen names into regenerated notes and tells the model to use them", async () => {
    process.env.MANAGED_HOSTING = "true";
    process.env.MANAGED_SUMMARY_PROVIDER = "openai";
    process.env.MANAGED_OPENAI_API_KEY = "test-openai-key";
    await prisma.workspaceSubscription.create({ data: { workspaceId, plan: "hosted_pro", status: "active" } });
    await renameSpeaker(workspaceId, meetingId, "them-1", "Sam");
    let request: { instructions: string; input: Array<{ content: Array<{ text: string }> }> } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      request = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({
        status: "completed", usage: { input_tokens: 1, output_tokens: 1 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ title: "t", overview: "Sam wants faster onboarding.", key_points: [], decisions: [], sections: [], action_items: [] }) }] }],
      }), { status: 200 });
    });
    expect((await regenerateNotes({ workspaceId, userId }, meetingId, "general")).ok).toBe(true);
    expect(request!.input[0]!.content[0]!.text).toContain("Sam: We need faster onboarding.");
    expect(request!.input[0]!.content[0]!.text).toContain("Them 2: I'll send the plan.");
    expect(request!.instructions).toContain("real names chosen by the user");
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).summary).toContain("Sam wants faster onboarding.");
  });
});
