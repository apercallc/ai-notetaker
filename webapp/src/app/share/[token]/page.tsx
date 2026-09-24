import { notFound } from "next/navigation";
import { getSharedMeeting } from "@/lib/sharing";
import { speakerLabel } from "@/lib/types";

export const metadata = { robots: { index: false, follow: false } };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default async function SharedMeetingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const meeting = await getSharedMeeting(token);
  if (!meeting) notFound();

  return (
    <main className="container shared-meeting">
      <p className="text-secondary">AI Notetaker shared meeting</p>
      <h1>{meeting.title}</h1>
      <p className="meeting-date">{formatDate(meeting.startedAt)} · {meeting.mode.replaceAll("_", " ")}</p>
      <h2 className="section-title">Summary</h2>
      <p>{meeting.summary || "No summary available."}</p>
      {meeting.actionItems.length > 0 && (
        <>
          <h2 className="section-title">Action items</h2>
          <ul className="action-list">
            {meeting.actionItems.map((item) => <li key={item.id} className="action-item">{item.text}{item.owner ? ` — ${item.owner}` : ""}</li>)}
          </ul>
        </>
      )}
      {meeting.transcript.length > 0 && (
        <>
          <h2 className="section-title">Transcript</h2>
          <div>{meeting.transcript.map((segment, index) => <div key={index} className="transcript-line"><span className="speaker">{speakerLabel(segment.speaker)}</span><span>{segment.text}</span></div>)}</div>
        </>
      )}
    </main>
  );
}
