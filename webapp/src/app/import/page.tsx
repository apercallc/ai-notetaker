import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/currentUser";
import { hostedAiEnabled } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { getImportCapability } from "@/lib/fileImport";
import { formatImportDuration } from "@/lib/importFormats";
import { ImportClient } from "./ImportClient";

export const metadata = { title: "Import a recording" };
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const { workspaceId } = await requireSession();
  if (!managedHostingEnabled() || !hostedAiEnabled()) notFound();
  const capability = await getImportCapability(workspaceId);

  return (
    <div className="container">
      <div className="page-header">
        <h1>Import a recording</h1>
        {capability.canProcess && capability.maxSeconds > 0 && (
          <p className="total-count">{formatImportDuration(capability.audioRemainingSeconds)} of audio left this period</p>
        )}
      </div>
      {!capability.toolsReady ? (
        <section className="settings-card">
          <h2>Import isn’t available here yet</h2>
          <p className="muted-copy">This server can’t read audio and video files right now. Live meeting capture still works. If you run this service yourself, install ffmpeg and restart it.</p>
        </section>
      ) : !capability.canProcess || capability.maxSeconds <= 0 ? (
        <section className="settings-card">
          <h2>Turn any recording into notes</h2>
          <p className="muted-copy">
            Upload an audio or video file and get a transcript, summary and action items. Imports count against the same hosted meeting hours as live meetings.
            {capability.maxSeconds > 0 ? " Your allowance for this period is used up; it resets with your billing period." : ""}
          </p>
          <Link className="button button-primary" href="/billing">See plans</Link>
        </section>
      ) : (
        <ImportClient maxSeconds={capability.maxSeconds} remainingSeconds={capability.audioRemainingSeconds} />
      )}
    </div>
  );
}
