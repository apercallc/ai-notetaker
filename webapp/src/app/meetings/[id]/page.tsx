import Link from "next/link";
import { notFound } from "next/navigation";
import { getMeeting } from "@/lib/meetings";
import { speakerLabel } from "@/lib/types";
import { ActionDoneCheckbox } from "@/components/ActionDoneCheckbox";
import { requireSession } from "@/lib/currentUser";
import { DeleteButton } from "./DeleteButton";
import { ExportButtons } from "./ExportButtons";
import { ShareMeeting } from "./ShareMeeting";
import { updateActionItemAction } from "./actions";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
}

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspaceId } = await requireSession();
  const meeting = await getMeeting(workspaceId, id);
  if (!meeting) notFound();

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">
        ← All meetings
      </Link>

      <div className="page-header">
        <h1>{meeting.title}</h1>
      </div>
      <p className="meeting-date">
        {formatDate(meeting.startedAt)} · {meeting.mode.replaceAll("_", " ")}
      </p>

      <h2 className="section-title">Summary</h2>
      <p>{meeting.summary}</p>

      {meeting.actionItems.length > 0 && (
        <>
          <h2 className="section-title">Action items</h2>
          <ul className="action-list">
            {meeting.actionItems.map((item) => (
              <li key={item.id} className={`action-item ${item.status === "done" ? "is-done" : ""}`}>
                <form action={updateActionItemAction} className="detail-action-form">
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="meetingId" value={meeting.id} />
                  <ActionDoneCheckbox
                    name="done"
                    label={`Mark "${item.text}" ${item.status === "done" ? "open" : "done"}`}
                    defaultChecked={item.status === "done"}
                  />
                  <span className="action-text">
                    {item.text}
                    {item.owner && <span className="meeting-owner"> — {item.owner}</span>}
                  </span>
                  <label className="action-due-label">
                    <span>Due</span>
                    <input type="date" name="dueAt" defaultValue={item.dueAt?.slice(0, 10) ?? ""} aria-label={`Due date for ${item.text}`} />
                  </label>
                  <button type="submit" className="text-link-muted">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}

      {meeting.transcript.length > 0 && (
        <>
          <h2 className="section-title">Transcript</h2>
          <div>
            {meeting.transcript.map((segment, i) => (
              <div key={i} className="transcript-line">
                <span className="speaker">
                  {speakerLabel(segment.speaker)} · {formatTime(segment.timestamp)}
                </span>
                <span>{segment.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="detail-actions">
        <ExportButtons meeting={meeting} />
        <DeleteButton meetingId={meeting.id} meetingTitle={meeting.title} />
      </div>
      <section className="share-section" aria-labelledby="share-heading">
        <h2 id="share-heading" className="section-title">Share privately</h2>
        <p className="text-secondary">Anyone with the link can view this meeting until it expires. Links are revocable and never expose your workspace or provider credentials.</p>
        <ShareMeeting meetingId={meeting.id} />
      </section>
    </div>
  );
}
