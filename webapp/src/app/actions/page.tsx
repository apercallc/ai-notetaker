import Link from "next/link";
import { listActionItems } from "@/lib/meetings";
import { updateActionItemAction } from "@/app/meetings/[id]/actions";

type ActionStatus = "open" | "done";

function formatDate(iso: Date): string {
  return iso.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export default async function ActionItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status: ActionStatus | undefined = rawStatus === "open" || rawStatus === "done" ? rawStatus : undefined;
  const items = await listActionItems(status);

  function filterHref(nextStatus?: ActionStatus): string {
    return nextStatus ? `/actions?status=${nextStatus}` : "/actions";
  }

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <Link href="/meetings" className="back-link">← Meetings</Link>
          <h1>Action items</h1>
        </div>
        <span className="total-count">{items.length} shown</span>
      </div>

      <nav className="filter-links" aria-label="Action item filters">
        <Link href={filterHref()} aria-current={!status ? "page" : undefined}>All</Link>
        <Link href={filterHref("open")} aria-current={status === "open" ? "page" : undefined}>Open</Link>
        <Link href={filterHref("done")} aria-current={status === "done" ? "page" : undefined}>Done</Link>
      </nav>

      {items.length === 0 ? (
        <p className="empty-state">
          {status === "done" ? "No completed action items yet." : status === "open" ? "You are all caught up." : "Action items from your meetings will appear here."}
        </p>
      ) : (
        <ul className="action-inbox" aria-label="Action items">
          {items.map((item) => (
            <li key={item.id} className={`action-inbox-row ${item.status === "done" ? "is-done" : ""}`}>
              <form action={updateActionItemAction} className="action-inbox-form">
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="meetingId" value={item.meeting.id} />
                <label className="action-checkbox">
                  <span className="sr-only">Mark “{item.text}” {item.status === "done" ? "open" : "done"}</span>
                  <input type="checkbox" name="done" value="1" defaultChecked={item.status === "done"} />
                </label>
                <div className="action-content">
                  <div className="action-title">{item.text}</div>
                  <div className="action-context">
                    <Link href={`/meetings/${item.meeting.id}`}>{item.meeting.title}</Link>
                    {item.owner ? <span> · {item.owner}</span> : null}
                    <span> · {formatDate(item.meeting.startedAt)}</span>
                  </div>
                </div>
                <label className="action-due-label">
                  <span>Due</span>
                  <input type="date" name="dueAt" defaultValue={dateInputValue(item.dueAt)} aria-label={`Due date for ${item.text}`} />
                </label>
                <button type="submit" className="button button-primary action-save">Save</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
