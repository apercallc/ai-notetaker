import { beforeEach, describe, expect, it, vi } from "vitest";

type Session = { userId: string; email: string; workspaceId: string; role: "owner" | "member" };
const h = vi.hoisted(() => ({
  session: null as null | { userId: string; email: string; workspaceId: string; role: "owner" | "member" },
  loadTeamRoster: vi.fn(),
  addMemberAs: vi.fn(),
  manageTeamAs: vi.fn(),
  getEntitlements: vi.fn(),
  recordClientError: vi.fn(),
  hit: vi.fn(),
}));

vi.mock("@/lib/managedAuth", () => ({
  getManagedSession: async () => h.session,
  managedUnauthorized: (requestId: string) => Response.json({ error: "managed session required", requestId }, { status: 401 }),
}));
vi.mock("@/lib/teamAdmin", () => ({ loadTeamRoster: h.loadTeamRoster, addMemberAs: h.addMemberAs, manageTeamAs: h.manageTeamAs }));
vi.mock("@/lib/usageLedger", () => ({ getEntitlements: h.getEntitlements }));
vi.mock("@/lib/clientErrors", () => ({ recordClientError: h.recordClientError, clientErrorLimiter: { hit: h.hit } }));

import { GET as teamGet, POST as teamPost } from "./team/route";
import { GET as entitlementsGet } from "./entitlements/route";
import { POST as clientErrorsPost } from "./client-errors/route";

const owner: Session = { userId: "u1", email: "o@example.com", workspaceId: "w1", role: "owner" };
const member: Session = { ...owner, userId: "u2", role: "member" };
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.hit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

describe("GET/POST /api/v1/team", () => {
  it("rejects anonymous callers with 401", async () => {
    expect((await teamGet(new Request("http://x/api/v1/team"))).status).toBe(401);
    expect((await teamPost(post("http://x/api/v1/team", {}))).status).toBe(401);
    expect(h.loadTeamRoster).not.toHaveBeenCalled();
  });

  it("forbids members from the roster and from team actions", async () => {
    h.session = member;
    expect((await teamGet(new Request("http://x/api/v1/team"))).status).toBe(403);
    h.manageTeamAs.mockResolvedValueOnce({ ok: false, error: "owner only" });
    const denied = await teamPost(post("http://x/api/v1/team", { operation: "remove", id: "m1" }));
    expect(denied.status).toBe(403);
  });

  it("returns the roster to owners and maps plan refusals to 422", async () => {
    h.session = owner;
    h.loadTeamRoster.mockResolvedValueOnce({ members: [] });
    const roster = await teamGet(new Request("http://x/api/v1/team"));
    expect(roster.status).toBe(200);
    expect(await roster.json()).toEqual({ members: [] });

    h.addMemberAs.mockResolvedValueOnce({ ok: false, error: "Team plan required" });
    expect((await teamPost(post("http://x/api/v1/team", { operation: "add", email: "a@b.co" }))).status).toBe(422);
    h.addMemberAs.mockResolvedValueOnce({ ok: true });
    expect((await teamPost(post("http://x/api/v1/team", { operation: "add", email: "a@b.co" }))).status).toBe(200);
  });

  it("sanitizes unexpected failures", async () => {
    h.session = owner;
    h.loadTeamRoster.mockRejectedValueOnce(new Error("secret db detail"));
    const failed = await teamGet(new Request("http://x/api/v1/team"));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("secret db detail");
  });
});

describe("GET /api/v1/entitlements", () => {
  it("requires a session, returns the workspace entitlements, and sanitizes errors", async () => {
    expect((await entitlementsGet(new Request("http://x/api/v1/entitlements"))).status).toBe(401);
    h.session = owner;
    h.getEntitlements.mockResolvedValueOnce({ plan: "hosted_pro" });
    const ok = await entitlementsGet(new Request("http://x/api/v1/entitlements"));
    expect(ok.status).toBe(200);
    expect(h.getEntitlements).toHaveBeenCalledWith("w1");
    h.getEntitlements.mockRejectedValueOnce(new Error("secret"));
    expect((await entitlementsGet(new Request("http://x/api/v1/entitlements"))).status).toBe(500);
  });
});

describe("POST /api/v1/client-errors", () => {
  it("requires a session", async () => {
    expect((await clientErrorsPost(post("http://x/api/v1/client-errors", {}))).status).toBe(401);
  });

  it("rate limits per user, rejects non-object and invalid reports, accepts valid ones", async () => {
    h.session = owner;
    h.hit.mockReturnValueOnce({ allowed: false, retryAfterMs: 4200 });
    const limited = await clientErrorsPost(post("http://x/api/v1/client-errors", {}));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");

    expect((await clientErrorsPost(post("http://x/api/v1/client-errors", []))).status).toBe(400);
    expect((await clientErrorsPost(post("http://x/api/v1/client-errors", "not json"))).status).toBe(400);

    h.recordClientError.mockReturnValueOnce({ ok: false, error: "bad surface" });
    const invalid = await clientErrorsPost(post("http://x/api/v1/client-errors", { surface: "x" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "bad surface" });

    h.recordClientError.mockReturnValueOnce({ ok: true });
    const ok = await clientErrorsPost(post("http://x/api/v1/client-errors", { surface: "popup" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true });
  });
});
