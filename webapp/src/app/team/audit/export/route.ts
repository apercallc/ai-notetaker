import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSessionContext } from "@/lib/sessions";
import { resolveActiveWorkspace } from "@/lib/workspaces";
import { auditCsv, auditLogAvailable, isAuditCategory } from "@/lib/auditLog";

/** CSV download of the activity log for owners. Same cookie session as the pages; the proxy already requires it. */
export async function GET(request: Request) {
  const context = await getSessionContext((await cookies()).get("session")?.value);
  const active = context ? await resolveActiveWorkspace(context.user.id, context.activeWorkspaceId) : null;
  if (!context || !active || context.user.mustChangePassword) return new NextResponse("Sign in required.", { status: 401 });
  if (active.role !== "owner") return new NextResponse("Only a workspace owner can download the activity log.", { status: 403 });
  if (!(await auditLogAvailable(active.workspaceId))) return new NextResponse("The activity log isn't included in this plan.", { status: 403 });

  const params = new URL(request.url).searchParams;
  const category = params.get("category") ?? undefined;
  const actor = params.get("actor")?.slice(0, 64) || undefined;
  const csv = await auditCsv(active.workspaceId, { ...(isAuditCategory(category) ? { category } : {}), ...(actor ? { actor } : {}) });
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
