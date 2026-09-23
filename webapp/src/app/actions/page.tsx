import Link from "next/link";
import { listActionItems, MAX_ACTION_ITEMS_PER_PAGE } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { updateActionItemAction } from "@/app/meetings/[id]/actions";
import { ActionDoneCheckbox } from "@/components/ActionDoneCheckbox";

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
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { workspaceId } = await requireSession();
  const { status: rawStatus, error } = await searchParams;
  const status: ActionStatus | undefined = rawStatus === "open" || rawStatus === "done" ? rawStatus : undefined;
  const items = await listActionItems(workspaceId, status);

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

      {items.length === MAX_ACTION_ITEMS_PER_PAGE && (
        // Otherwise "500 shown" silently reads as "500 exist" — the reader
        // has no way to tell the list was truncated.
        <p className="muted-copy">
          Showing the first {MAX_ACTION_ITEMS_PER_PAGE}. Filter by status, or open a meeting to see the rest.
        </p>
      )}

      <nav className="filter-links" aria-label="Action item filters">
        <Link href={filterHref()} aria-current={!status ? "page" : undefined}>All</Link>
        <Link href={filterHref("open")} aria-current={status === "open" ? "page" : undefined}>Open</Link>
        <Link href={filterHref("done")} aria-current={status === "done" ? "page" : undefined}>Done</Link>
      </nav>

      {error && (
        <p className="error-text" role="alert">
          {error === "missing-action" ? "That action item no longer exists." : "We could not save that action item. Check the date and try again."}
        </p>
      )}

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
                <ActionDoneCheckbox
                  name="done"
                  label={`Mark "${item.text}" ${item.status === "done" ? "open" : "done"}`}
                  defaultChecked={item.status === "done"}
                />
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
                <button type="submit" className="button button-secondary action-save">Save</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
