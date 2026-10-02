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
import { listFolders } from "@/lib/library";
import { prisma } from "@/lib/db";
import { languageName } from "@/lib/languages";
import { folderPath } from "@/lib/libraryTree";
import { SummaryBlocks } from "@/components/SummaryBlocks";
import { modeLabel } from "@/lib/meetingText";
import { requireSession } from "@/lib/currentUser";
import { ActionItemRow } from "@/components/ActionItemRow";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CopyButton } from "@/components/CopyButton";
import { LocalTime } from "@/components/LocalTime";
import { ProcessingBadge, failureReason } from "@/components/ProcessingBadge";
import { RetryProcessing } from "@/components/RetryProcessing";
import { DeleteButton } from "./DeleteButton";
import { ExportButtons } from "./ExportButtons";
import { NoteBody } from "./NoteBody";
import { NotesTemplate } from "./NotesTemplate";
import { SpeakerName } from "./SpeakerName";
import { ShareMeeting } from "./ShareMeeting";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { TitleEditor } from "./TitleEditor";

// generateMetadata and the page both need the meeting; cache() makes that one query.
const loadMeeting = cache((workspaceId: string, id: string) => getMeeting(workspaceId, id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { workspaceId } = await requireSession();
  const meeting = await loadMeeting(workspaceId, id);
  return { title: meeting?.title ?? "Meeting not found" };
}

export default async function MeetingDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string; error?: string }> }) {
  const { id } = await params;
  const { edit, error } = await searchParams;
  const { workspaceId } = await requireSession();
  const meeting = await loadMeeting(workspaceId, id);
  if (!meeting) notFound();

  const [shares, folders, workspace] = await Promise.all([
    listActiveShares(workspaceId, meeting.id),
    listFolders(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { summaryLanguage: true } }),
  ]);
  const crumbs = folderPath(folders, meeting.folderId);
  const summaryLanguage = workspace?.summaryLanguage ?? "";
  const summaryBlocks = parseSummary(meeting.summary);
  const turns = groupTurns(meeting.startedAt, meeting.endedAt, meeting.transcript);
  const mode = modeLabel(meeting.mode);
  const processing = meeting.processing;
  const inFlight = processing?.status === "processing";
  const canRegenerate = managedHostingEnabled() && meeting.processingMode === "managed" && meeting.transcript.length > 0 && !inFlight && processing?.status !== "error";

  return (
    <div className="container">
      <AutoRefresh active={inFlight} />
      <nav className="breadcrumbs" aria-label="Folder path">
        <ol>
          <li><Link href="/meetings">Library</Link></li>
          {crumbs.map((crumb) => <li key={crumb.id}><Link href={`/meetings?folder=${crumb.id}`}>{crumb.name}</Link></li>)}
        </ol>
      </nav>
      {error && <p className="error-text" role="alert">{error.slice(0, 200)}</p>}

      <TitleEditor key={meeting.title} meetingId={meeting.id} title={meeting.title} />
      <p className="meeting-date">
        <LocalTime iso={meeting.startedAt} />
        {mode && <> · {mode}</>}
        {languageName(meeting.language) && <> · {languageName(meeting.language)}</>}
        {processing && <span className="meeting-status"><ProcessingBadge state={processing} /></span>}
      </p>

      {processing?.status === "error" && (
        <div className="callout callout-danger" role="alert">
          <p><strong>Processing failed.</strong> {failureReason(processing.errorMessage)}</p>
          <RetryProcessing meetingId={meeting.id} className="button button-secondary" />
        </div>
      )}

      {canRegenerate && <NotesTemplate meetingId={meeting.id} mode={meeting.mode} used={meeting.notesRegenerations} edited={meeting.summaryEditedAt !== null} defaultLanguage={summaryLanguage} />}

      <section aria-labelledby="summary-heading">
        <div className="section-head">
          <h2 id="summary-heading" className="section-title">Summary</h2>
          {meeting.summary && <CopyButton text={meeting.summary} label="Copy summary" className="button button-secondary button-small" />}
        </div>
        <NoteBody
          meetingId={meeting.id}
          summary={meeting.summary}
          version={meeting.version}
          hasPrevious={meeting.hasPreviousSummary}
          startEditing={edit === "1" || (meeting.isManual && meeting.summary === "")}
        >
          {summaryBlocks.length === 0 ? (
            <p className="muted-copy">{inFlight ? "Your notes are being prepared. This page updates on its own." : "No summary was generated for this meeting."}</p>
          ) : (
            <SummaryBlocks blocks={summaryBlocks} />
          )}
        </NoteBody>
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

      {turns.length > 0 && (
        <section aria-labelledby="transcript-heading">
          <h2 id="transcript-heading" className="section-title">Transcript</h2>
          {turns.every((turn) => turn.speaker === "speaker") && (
            <p className="muted-copy">Speakers aren’t separated for this recording.</p>
          )}
          <ol className="transcript">
            {turns.map((turn, index) => (
              <li key={index} className="turn">
                <div className="turn-head">
                  <SpeakerName
                    meetingId={meeting.id}
                    speakerKey={turn.speaker}
                    label={speakerLabel(turn.speaker, meeting.speakerNames)}
                    renamed={Boolean(meeting.speakerNames?.[turn.speaker])}
                    isYou={turn.speaker === "you"}
                  />
                  {turn.offsetSeconds !== null && <span className="offset">{formatOffset(turn.offsetSeconds)}</span>}
                </div>
                <p>{turn.lines.join(" ")}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="detail-actions">
        <ExportButtons meeting={meeting} manual={meeting.isManual} />
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
