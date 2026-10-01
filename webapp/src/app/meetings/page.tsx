import Link from "next/link";
import type { Metadata } from "next";
import { listMeetings } from "@/lib/meetings";
import { MAX_SEARCH_LENGTH } from "@/lib/meetingConstants";
import { requireSession } from "@/lib/currentUser";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { getEntitlements } from "@/lib/usageLedger";
import { getRequestContext } from "@/lib/requestContext";
import { prisma } from "@/lib/db";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Highlight } from "@/components/Highlight";
import { LocalTime } from "@/components/LocalTime";
import { OnboardingCard, type OnboardingPlan } from "@/components/OnboardingCard";
import { ProcessingBadge } from "@/components/ProcessingBadge";
import { RetryProcessing } from "@/components/RetryProcessing";
import { highlightParts } from "@/lib/snippet";
import { MEETING_RANGES, parseMeetingRange, rangeStart } from "@/lib/dateRange";
import { SearchForm } from "./SearchForm";

const PAGE_SIZE = 50;
// The data layer caps offsets at 100,000; keeping the UI bound aligned avoids
// issuing an expensive, guaranteed-to-fail query for a crafted page number.
const MAX_PAGE = 2_000;

type SearchParams = Promise<{ q?: string; page?: string; range?: string; error?: string }>;

function cleanQuery(raw: string | undefined): string | undefined {
  // Keep a pasted or hand-crafted URL from turning a normal page view into a
  // validation error; the API still rejects oversized queries explicitly.
  return raw?.trim().slice(0, MAX_SEARCH_LENGTH) || undefined;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const q = cleanQuery((await searchParams).q);
  return { title: q ? `Search: ${q}` : "Meetings" };
}

async function serviceOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const { protocol, host } = await getRequestContext();
  return `${protocol ?? "https"}://${host ?? "your-instance"}`;
}

export default async function MeetingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { userId, workspaceId } = await requireSession();
  const { q: rawQuery, page: rawPage, range: rawRange, error } = await searchParams;
  const q = cleanQuery(rawQuery);
  const range = parseMeetingRange(rawRange);
  const since = rangeStart(range);
  const parsedPage = Number(rawPage ?? "1");
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= MAX_PAGE ? parsedPage : 1;
  let result = await listMeetings(workspaceId, { query: q, since, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const { total } = result;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  if (currentPage !== page) {
    result = await listMeetings(workspaceId, { query: q, since, limit: PAGE_SIZE, offset: (currentPage - 1) * PAGE_SIZE });
  }
  const { meetings } = result;

  function hrefFor(next: { range?: string; page?: number }): string {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (next.range) params.set("range", next.range);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    return qs ? `/meetings?${qs}` : "/meetings";
  }
  const pageHref = (nextPage: number) => hrefFor({ range, page: nextPage });

  const rangeLabel = MEETING_RANGES.find((item) => item.id === range)?.label.toLowerCase();
  const countText = (q
    ? `${total} ${total === 1 ? "result" : "results"} for “${q}”`
    : `${total} ${total === 1 ? "meeting" : "meetings"}`) + (rangeLabel ? `, ${rangeLabel}` : "");

  let onboarding: React.ReactNode = null;
  if (total === 0 && !q && !range) {
    const managed = managedHostingEnabled();
    const [user, entitlements] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
      managed ? getEntitlements(workspaceId) : Promise.resolve(null),
    ]);
    const plan: OnboardingPlan | null = entitlements
      ? { label: entitlements.planLabel, isTrial: entitlements.isTrial, used: entitlements.used, limit: entitlements.limit }
      : null;
    onboarding = <OnboardingCard email={user?.email ?? "your account email"} origin={await serviceOrigin()} managed={managed} plan={plan} />;
  }

  return (
    <div className="container">
      <AutoRefresh active={meetings.some((meeting) => meeting.processing?.status === "processing")} />
      <div className="page-header">
        <h1>Meetings</h1>
        <p className="total-count" role="status" aria-live="polite">{countText}</p>
      </div>

      <SearchForm initialQuery={q ?? ""} range={range} />
      <nav className="filter-chips" aria-label="Filter by date">
        <Link href={hrefFor({})} aria-current={range ? undefined : "true"}>All time</Link>
        {MEETING_RANGES.map((item) => (
          <Link key={item.id} href={hrefFor({ range: item.id })} aria-current={range === item.id ? "true" : undefined}>{item.label}</Link>
        ))}
      </nav>

      {error && (
        <p className="error-text" role="alert">
          {error === "delete-failed" ? "That meeting could not be deleted. Try again." : "That meeting request was invalid."}
        </p>
      )}

      {meetings.length === 0 ? (
        onboarding ?? (
          <div className="empty-state">
            <p>{q ? `No meetings match “${q}”${rangeLabel ? ` in the ${rangeLabel}` : ""}.` : "No meetings in this period."}</p>
            <Link href="/meetings">Clear filters</Link>
          </div>
        )
      ) : (
        <ul className="meeting-list">
          {meetings.map((meeting) => (
            <li key={meeting.id} className="meeting-card">
              <div className="title">
                <Link href={`/meetings/${meeting.id}`} className="card-link">
                  {q ? <Highlight parts={highlightParts(meeting.title, q)} /> : meeting.title}
                </Link>
              </div>
              <div className="meta">
                <LocalTime iso={meeting.startedAt} />
                {meeting.openActionItems > 0 && (
                  <span className="open-actions"> · {meeting.openActionItems} open {meeting.openActionItems === 1 ? "action" : "actions"}</span>
                )}
                {meeting.processing && <span className="meeting-status"><ProcessingBadge state={meeting.processing} /></span>}
              </div>
              {meeting.match ? (
                <div className="preview">
                  <span className="match-source">{meeting.match.source}</span> <Highlight parts={meeting.match.parts} />
                </div>
              ) : meeting.summaryPreview ? (
                <div className="preview">{meeting.summaryPreview}</div>
              ) : null}
              {meeting.processing?.status === "error" && (
                <div className="card-actions">
                  <RetryProcessing meetingId={meeting.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="pagination" aria-label="Meeting pages">
          {currentPage > 1 ? <Link href={pageHref(currentPage - 1)}>← Newer</Link> : <span aria-hidden="true" />}
          <span aria-current="page">Page {currentPage} of {totalPages}</span>
          {currentPage < totalPages ? <Link href={pageHref(currentPage + 1)}>Older →</Link> : <span aria-hidden="true" />}
        </nav>
      )}
    </div>
  );
}
