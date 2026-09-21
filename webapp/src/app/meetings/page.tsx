import Link from "next/link";
import { listMeetings } from "@/lib/meetings";
import { logout } from "@/app/login/actions";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { meetings, total } = await listMeetings({ query: q, limit: 50 });

  return (
    <div className="container">
      <div className="page-header">
        <h1>Meetings</h1>
        <span style={{ color: "var(--color-text-muted)", fontSize: "0.9375rem" }}>
          {total} total
        </span>
      </div>

      <form method="get" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search meetings…"
          className="search-input"
          aria-label="Search meetings"
        />
      </form>

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
                <div className="meta">{formatDate(meeting.startedAt)}</div>
                <div className="preview">{meeting.summaryPreview}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form action={logout} style={{ marginTop: "var(--space-5)" }}>
        <button type="submit" className="text-link-muted">
          Sign out
        </button>
      </form>
    </div>
  );
}
