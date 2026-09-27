import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSharedMeeting } from "@/lib/sharing";
import { clientIpFromHeaders } from "@/lib/requestContext";
import { shareLookupLimiter } from "@/lib/lookupThrottle";
import { formatOffset, groupTurns } from "@/lib/transcript";
import { parseSummary } from "@/lib/summaryFormat";
import { modeLabel } from "@/lib/meetingText";
import { speakerLabel } from "@/lib/types";

export function generateMetadata(): Metadata {
  return {
    robots: { index: false, follow: false },
    // A share URL contains the token in the path; the destination of any
    // outbound link (including an attacker's) must never learn it, or
    // anyone who can get the victim to click a link while viewing this
    // page could replay the token.
    other: { referrer: "no-referrer" },
  };
}

/** The page a reader lands on when the token no longer opens anything. */
function LinkUnavailable() {
  return (
    <main className="container shared-meeting">
      <div className="empty-state">
        <h1>This link has expired or was revoked</h1>
        <p className="muted-copy">
          Share links stop working when they pass their expiry date or when the
          person who shared the meeting revokes them. Ask them for a new link.
        </p>
      </div>
    </main>
  );
}

export default async function SharedMeetingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = await headers();
  const ip = clientIpFromHeaders((name) => store.get(name));
  const lookup = shareLookupLimiter.hit(ip ?? "unknown");
  // Same card for throttled and dead links: a throttled caller gets the
  // page they would eventually get anyway, without learning how close
  // they are to the limit.
  if (!lookup.allowed) return <LinkUnavailable />;

  const meeting = await getSharedMeeting(token);
  if (!meeting) return <LinkUnavailable />;

  const summaryBlocks = parseSummary(meeting.summary);
  const turns = groupTurns(meeting.startedAt, meeting.endedAt, meeting.transcript);
  const mode = modeLabel(meeting.mode);

  return (
    <main className="container shared-meeting">
      <p className="text-secondary">AI Notetaker shared meeting</p>
      <h1>{meeting.title}</h1>
      <p className="meeting-date">
        {new Date(meeting.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        {mode && <> · {mode}</>}
      </p>

      <h2 className="section-title">Summary</h2>
      {summaryBlocks.length === 0 ? (
        <p className="muted-copy">No summary available.</p>
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

      {meeting.actionItems.length > 0 && (
        <>
          <h2 className="section-title">Action items</h2>
          <ul className="action-list">
            {meeting.actionItems.map((item) => (
              <li key={item.id} className="action-item">{item.text}{item.owner ? ` — ${item.owner}` : ""}</li>
            ))}
          </ul>
        </>
      )}

      {turns.length > 0 && (
        <>
          <h2 className="section-title">Transcript</h2>
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
        </>
      )}
    </main>
  );
}