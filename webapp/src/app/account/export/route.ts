import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireSession } from "@/lib/currentUser";
import { exportFileName, exportHeader, streamWorkspaceMeetings } from "../exportData";

/**
 * Downloads every meeting in the caller's active workspace as one JSON file.
 * Owner-only (a bulk copy of everyone's notes) and recorded in the audit log.
 * Membership comes from the session (requireSession re-checks it), never from
 * a query parameter, so there is no way to ask for another tenant's data.
 * The body is streamed one batch at a time so a large archive stays bounded.
 */
export async function GET() {
  const session = await requireSession({ allowPasswordChange: false });
  if (session.role !== "owner") return new Response("Only the workspace owner can export every note.", { status: 403 });
  const workspace = await prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { id: true, name: true } });
  if (!workspace) return new Response("Not found", { status: 404 });

  await recordAudit({ workspaceId: workspace.id, actorUserId: session.userId, action: "workspace.export", targetType: "workspace", targetId: workspace.id });

  const now = new Date();
  const encoder = new TextEncoder();
  const header = JSON.stringify(exportHeader(workspace.id, workspace.name, now)).slice(0, -1);
  const meetings = streamWorkspaceMeetings(workspace.id);
  let first = true;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${header},"meetings":[`));
    },
    async pull(controller) {
      let next: Awaited<ReturnType<typeof meetings.next>>;
      try {
        next = await meetings.next();
      } catch (error) {
        // Headers (200) are already sent. Closing normally would hand the user a truncated file
        // that looks like a finished backup; erroring the stream makes the download fail visibly.
        console.error("workspace export failed mid-stream", { workspaceId: workspace.id, error: error instanceof Error ? error.message : String(error) });
        controller.error(error);
        return;
      }
      if (next.done) {
        controller.enqueue(encoder.encode("]}\n"));
        controller.close();
        return;
      }
      const chunk = next.value.map((meeting) => JSON.stringify(meeting)).join(",");
      controller.enqueue(encoder.encode(`${first ? "" : ","}${chunk}`));
      first = false;
    },
    async cancel() {
      await meetings.return();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(workspace.name, now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
