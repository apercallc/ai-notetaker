import Link from "next/link";
import { notFound } from "next/navigation";
import { getMeeting } from "@/lib/meetings";
import { DeleteButton } from "./DeleteButton";

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
  const meeting = await getMeeting(id);
  if (!meeting) notFound();

  return (
    <div className="container">
      <Link href="/meetings" className="back-link">
        ← All meetings
      </Link>

      <div className="page-header">
        <h1>{meeting.title}</h1>
      </div>
      <p className="meta" style={{ color: "var(--color-text-muted)", marginTop: "-16px" }}>
        {formatDate(meeting.startedAt)}
      </p>

      <h2 className="section-title">Summary</h2>
      <p>{meeting.summary}</p>

      {meeting.actionItems.length > 0 && (
        <>
          <h2 className="section-title">Action items</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {meeting.actionItems.map((item, i) => (
              <li key={i} className="action-item">
                {item.text}
                {item.owner && (
                  <span style={{ color: "var(--color-text-muted)" }}> — {item.owner}</span>
                )}
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
                  {segment.speaker} · {formatTime(segment.timestamp)}
                </span>
                <span>{segment.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: "32px" }}>
        <DeleteButton meetingId={meeting.id} meetingTitle={meeting.title} />
      </div>
    </div>
  );
}
