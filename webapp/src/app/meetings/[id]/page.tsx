import { cache } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMeeting } from "@/lib/meetings";
import { listActiveShares } from "@/lib/sharing";
import { speakerLabel } from "@/lib/types";
import { formatOffset, groupTurns } from "@/lib/transcript";
import { parseSummary } from "@/lib/summaryFormat";
import { actionItemsToText } from "@/lib/actionItems";
import { modeLabel } from "@/lib/meetingText";
import { requireSession } from "@/lib/currentUser";
import { ActionItemRow } from "@/components/ActionItemRow";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CopyButton } from "@/components/CopyButton";
import { LocalTime } from "@/components/LocalTime";
import { ProcessingBadge, failureReason } from "@/components/ProcessingBadge";
import { RecordingPlayer } from "@/components/RecordingPlayer";
import { RetryProcessing } from "@/components/RetryProcessing";
import { DeleteButton } from "./DeleteButton";
import { ExportButtons } from "./ExportButtons";
import { ShareMeeting } from "./ShareMeeting";
import { TitleEditor } from "./TitleEditor";

// generateMetadata and the page both need the meeting; cache() makes that one query.
const loadMeeting = cache((workspaceId: string, id: string) => getMeeting(workspaceId, id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { workspaceId } = await requireSession();
  const meeting = await loadMeeting(workspaceId, id);
  return { title: meeting?.title ?? "Meeting not found" };
}

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await requireSession();
  const meeting = await loadMeeting(workspaceId, id);
  if (!meeting) notFound();

  const shares = await listActiveShares(workspaceId, meeting.id);
  const summaryBlocks = parseSummary(meeting.summary);
  const turns = groupTurns(meeting.startedAt, meeting.endedAt, meeting.transcript);
  const mode = modeLabel(meeting.mode);
  const processing = meeting.processing;
  const inFlight = processing?.status === "processing";
  const hasRecording = meeting.recordingChannels.length > 0;

  return (
    <div className="container">
      <AutoRefresh active={inFlight} />
      <Link href="/meetings" className="back-link">← All meetings</Link>

      <TitleEditor key={meeting.title} meetingId={meeting.id} title={meeting.title} />
      <p className="meeting-date">
        <LocalTime iso={meeting.startedAt} />
        {mode && <> · {mode}</>}
        {processing && <span className="meeting-status"><ProcessingBadge state={processing} /></span>}
      </p>

      {processing?.status === "error" && (
        <div className="callout callout-danger" role="alert">
          <p><strong>Processing failed.</strong> {failureReason(processing.errorMessage)}</p>
          <RetryProcessing meetingId={meeting.id} className="button button-secondary" />
        </div>
      )}

      <section aria-labelledby="summary-heading">
        <div className="section-head">
          <h2 id="summary-heading" className="section-title">Summary</h2>
          {meeting.summary && <CopyButton text={meeting.summary} label="Copy summary" className="button button-secondary button-small" />}
        </div>
        {summaryBlocks.length === 0 ? (
          <p className="muted-copy">{inFlight ? "Your notes are being prepared. This page updates on its own." : "No summary was generated for this meeting."}</p>
        ) : (
          <div className="summary">
            {summaryBlocks.map((block, index) =>
              block.type === "heading" ? (
                <h3 key={index}>{block.text}</h3>
              ) : block.type === "list" ? (
                block.ordered ? (
                  <ol key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ol>
                ) : (
                  <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
                )
              ) : (
                <p key={index}>{block.text}</p>
              ),
            )}
          </div>
        )}
      </section>

      {meeting.actionItems.length > 0 && (
        <section aria-labelledby="actions-heading">
          <div className="section-head">
            <h2 id="actions-heading" className="section-title">Action items</h2>
            <CopyButton text={actionItemsToText(meeting.actionItems)} label="Copy action items" className="button button-secondary button-small" />
          </div>
          <ul className="action-list">
            {meeting.actionItems.map((item) => (
              <ActionItemRow
                key={item.id}
                id={item.id}
                meetingId={meeting.id}
                surface="meeting"
                text={item.text}
                owner={item.owner}
                initialDone={item.status === "done"}
                initialDueAt={item.dueAt}
              />
            ))}
          </ul>
        </section>
      )}

      {hasRecording && (
        <section aria-labelledby="recording-heading">
          <h2 id="recording-heading" className="section-title">Recording</h2>
          <RecordingPlayer meetingId={meeting.id} channels={meeting.recordingChannels} />
        </section>
      )}

      {turns.length > 0 && (
        <section aria-labelledby="transcript-heading">
          <h2 id="transcript-heading" className="section-title">Transcript</h2>
          <ol className="transcript">
            {turns.map((turn, index) => (
              <li key={index} className="turn">
                <div className="turn-head">
                  <span className={`speaker${turn.speaker === "you" ? " is-you" : ""}`}>{speakerLabel(turn.speaker)}</span>
                  {turn.offsetSeconds !== null && <span className="offset">{formatOffset(turn.offsetSeconds)}</span>}
                </div>
                <p>{turn.lines.join(" ")}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="detail-actions">
        <ExportButtons meeting={meeting} />
        <DeleteButton meetingId={meeting.id} meetingTitle={meeting.title} />
      </div>

      <section className="share-section" aria-labelledby="share-heading">
        <h2 id="share-heading" className="section-title">Share privately</h2>
        <p className="muted-copy">Anyone with a link can read this meeting until it expires or you revoke it. Links never expose your workspace or account.</p>
        <ShareMeeting meetingId={meeting.id} links={shares} />
      </section>
    </div>
  );
}
