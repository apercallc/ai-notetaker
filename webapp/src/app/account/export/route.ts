import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/currentUser";
import { exportFileName, exportHeader, streamWorkspaceMeetings } from "../exportData";

/**
 * Downloads every meeting in the caller's active workspace as one JSON file.
 * Membership comes from the session (requireSession re-checks it), never from
 * a query parameter, so there is no way to ask for another tenant's data.
 * The body is streamed one batch at a time so a large archive stays bounded.
 */
export async function GET() {
  const session = await requireSession({ allowPasswordChange: false });
  const workspace = await prisma.workspace.findUnique({ where: { id: session.workspaceId }, select: { id: true, name: true } });
  if (!workspace) return new Response("Not found", { status: 404 });

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
      const next = await meetings.next();
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
