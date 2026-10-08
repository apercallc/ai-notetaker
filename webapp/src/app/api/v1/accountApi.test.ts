import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as overview } from "./account/overview/route";
import { POST as syncToken } from "./account/desktop-sync-token/route";
import { POST as logout } from "./auth/logout/route";
import { POST as desktopCode } from "./auth/desktop-code/route";
import { issueAuthToken } from "@/lib/authTokens";
import { createApiToken } from "@/lib/apiTokens";
import { GET as teamRoster, POST as teamAction } from "./team/route";
import { resolveApiToken, DESKTOP_NOTES_SCOPE } from "@/lib/apiTokens";
import { prisma } from "@/lib/db";

const WORKSPACE_ID = randomUUID();
const OWNER_ID = randomUUID();
const MEMBER_ID = randomUUID();
const originalManagedHosting = process.env.MANAGED_HOSTING;

async function principal(userId: string, email: string, role: "owner" | "member"): Promise<Record<string, string>> {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "test-hash", emailVerifiedAt: new Date() } });
  await prisma.workspaceMembership.create({ data: { userId, workspaceId: WORKSPACE_ID, role } });
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return { authorization: `Bearer ${session.id}`, "content-type": "application/json" };
}

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  new Request(url, { method: "POST", headers, body: JSON.stringify(body) });

let owner: Record<string, string>;
let member: Record<string, string>;

beforeEach(async () => {
  process.env.MANAGED_HOSTING = "true";
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Account API workspace" } });
  await prisma.workspaceSubscription.create({ data: { workspaceId: WORKSPACE_ID, plan: "hosted_pro", status: "active" } });
  owner = await principal(OWNER_ID, "account-owner@example.com", "owner");
  member = await principal(MEMBER_ID, "account-member@example.com", "member");
});

afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.user.deleteMany({ where: { email: { in: ["account-owner@example.com", "account-member@example.com", "invited-account@example.com"] } } });
  if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
  else process.env.MANAGED_HOSTING = originalManagedHosting;
});

describe("desktop account API", () => {
  it("requires a hosted session for every route", async () => {
    expect((await overview(new Request("http://localhost/api/v1/account/overview"))).status).toBe(401);
    expect((await teamRoster(new Request("http://localhost/api/v1/team"))).status).toBe(401);
    expect((await syncToken(post("http://localhost/api/v1/account/desktop-sync-token", {}, {}))).status).toBe(401);
  });

  it("reports plan, usage and questions, and hides purchase offers from members", async () => {
    const ownerBody = await (await overview(new Request("http://localhost/api/v1/account/overview", { headers: owner }))).json();
    expect(ownerBody.account).toEqual({ email: "account-owner@example.com", role: "owner" });
    expect(ownerBody.workspace.name).toBe("Account API workspace");
    expect(ownerBody.entitlements.plan).toBe("hosted_pro");
    expect(ownerBody.entitlements.limit).toBeGreaterThan(0);
    expect(ownerBody.entitlements.audio.limitSeconds).toBeGreaterThan(0);
    expect(ownerBody.chat.limit).toBeGreaterThan(0);

    const memberBody = await (await overview(new Request("http://localhost/api/v1/account/overview", { headers: member }))).json();
    expect(memberBody.account.role).toBe("member");
    expect(memberBody.offers).toEqual([]);
  });

  it("lets only the owner see and change the team", async () => {
    expect((await teamRoster(new Request("http://localhost/api/v1/team", { headers: member }))).status).toBe(403);
    const denied = await teamAction(post("http://localhost/api/v1/team", member, { operation: "add", email: "invited-account@example.com" }));
    expect(denied.status).toBe(403);

    // Pro is one person syncing their own devices; inviting teammates is the Team plan.
    const proDenied = await teamAction(post("http://localhost/api/v1/team", owner, { operation: "add", email: "invited-account@example.com" }));
    expect(proDenied.status).toBe(422);
    expect((await proDenied.json()).error).toMatch(/Team plan/i);
    await prisma.workspaceSubscription.update({ where: { workspaceId: WORKSPACE_ID }, data: { plan: "hosted_team" } });

    const added = await teamAction(post("http://localhost/api/v1/team", owner, { operation: "add", email: "invited-account@example.com" }));
    expect(added.status).toBe(200);
    expect((await added.json()).temporaryPassword).toBeTruthy();

    const roster = await (await teamRoster(new Request("http://localhost/api/v1/team", { headers: owner }))).json();
    expect(roster.members.map((entry: { email: string }) => entry.email).sort()).toEqual([
      "account-member@example.com",
      "account-owner@example.com",
      "invited-account@example.com",
    ]);
  });

  it("keeps at least one owner", async () => {
    const roster = await (await teamRoster(new Request("http://localhost/api/v1/team", { headers: owner }))).json();
    const self = roster.members.find((entry: { email: string }) => entry.email === "account-owner@example.com");
    const response = await teamAction(post("http://localhost/api/v1/team", owner, { operation: "role", id: self.id, role: "member" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/at least one owner/i);
  });


  it("mints a revocable notes-only token bound to the signed-in workspace", async () => {
    const response = await syncToken(post("http://localhost/api/v1/account/desktop-sync-token", owner, {}));
    expect(response.status).toBe(200);
    const { token } = await response.json();
    const resolved = await resolveApiToken(token, Date.now(), DESKTOP_NOTES_SCOPE);
    expect(resolved?.workspaceId).toBe(WORKSPACE_ID);
    // It must not work as a hosted session.
    expect((await overview(new Request("http://localhost/api/v1/account/overview", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(401);
  });

  it("signing out revokes the token on the server", async () => {
    const created = await createApiToken(OWNER_ID, { label: "Desktop sign-in" });
    const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
    expect((await overview(new Request("http://localhost/api/v1/account/overview", { headers }))).status).toBe(200);
    expect((await logout(new Request("http://localhost/api/v1/auth/logout", { method: "POST", headers }))).status).toBe(204);
    expect((await overview(new Request("http://localhost/api/v1/account/overview", { headers }))).status).toBe(401);
    expect((await logout(new Request("http://localhost/api/v1/auth/logout", { method: "POST" }))).status).toBe(401);
  });

  it("signs the desktop in with a one-time code from the web app, for any kind of account", async () => {
    const { token } = await issueAuthToken({ purpose: "desktop_connect", email: "account-owner@example.com", userId: OWNER_ID, workspaceId: WORKSPACE_ID });
    const exchange = (code: string) => desktopCode(new Request("http://localhost/api/v1/auth/desktop-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }));
    const first = await exchange(token);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ accountId: OWNER_ID, workspaceId: WORKSPACE_ID, role: "owner", email: "account-owner@example.com" });
    // The session works as a hosted session.
    expect((await overview(new Request("http://localhost/api/v1/account/overview", { headers: { authorization: `Bearer ${body.accessToken}` } }))).status).toBe(200);
    // A code works once, and garbage never does.
    expect((await exchange(token)).status).toBe(401);
    expect((await exchange("nope")).status).toBe(401);
    expect((await desktopCode(new Request("http://localhost/api/v1/auth/desktop-code", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(400);
  });
});
