import Link from "next/link";
import { listMeetings, MAX_SEARCH_LENGTH } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { logout } from "@/app/login/actions";
import { SearchForm } from "./SearchForm";

const PAGE_SIZE = 50;
// The data layer caps offsets at 100,000; keeping the UI bound aligned avoids
// issuing an expensive, guaranteed-to-fail query for a crafted page number.
const MAX_PAGE = 2_000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; error?: string }>;
}) {
  const { workspaceId } = await requireSession();
  const { q: rawQuery, page: rawPage, error } = await searchParams;
  // Keep a pasted or hand-crafted URL from turning a normal page view into a
  // validation error; the API still rejects oversized queries explicitly.
  const q = rawQuery?.trim().slice(0, MAX_SEARCH_LENGTH);
  const parsedPage = Number(rawPage ?? "1");
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= MAX_PAGE ? parsedPage : 1;
  let result = await listMeetings(workspaceId, { query: q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const { total } = result;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  if (currentPage !== page) {
    result = await listMeetings(workspaceId, { query: q, limit: PAGE_SIZE, offset: (currentPage - 1) * PAGE_SIZE });
  }
  const { meetings } = result;

  function pageHref(nextPage: number): string {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("page", String(nextPage));
    return `/meetings?${params.toString()}`;
  }

  return (
    <div className="container">
      <div className="page-header">
        <h1>Meetings</h1>
        <div className="header-links">
          <Link href="/actions">Action items</Link>
          <span className="total-count">{total} total</span>
        </div>
      </div>

      <SearchForm initialQuery={q ?? ""} />

      {error && (
        <p className="error-text" role="alert">
          {error === "delete-failed" ? "That meeting could not be deleted. Try again." : "That meeting request was invalid."}
        </p>
      )}

      {meetings.length === 0 ? (
        <p className="empty-state">
          {q ? `No meetings match "${q}".` : "No meetings yet — they'll show up here once your extension sends its first note."}
        </p>
      ) : (
        <ul className="meeting-list">
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <Link href={`/meetings/${meeting.id}`} className="meeting-card">
                <div className="title">{meeting.title}</div>
                <div className="meta">
                  {formatDate(meeting.startedAt)}
                  {meeting.openActionItems > 0 ? <span className="open-actions"> · {meeting.openActionItems} open action{meeting.openActionItems === 1 ? "" : "s"}</span> : null}
                </div>
                <div className="preview">{meeting.summaryPreview}</div>
              </Link>
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

      <form action={logout} className="signout-form">
        <button type="submit" className="text-link-muted">
          Sign out
        </button>
      </form>
    </div>
  );
}
