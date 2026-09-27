import Link from "next/link";
import { listActionItems } from "@/lib/meetings";
import { requireSession } from "@/lib/currentUser";
import { ActionItemRow } from "@/components/ActionItemRow";

type ActionStatus = "open" | "done";

/**
 * The "mine" filter matches action items recorded by this user that are
 * unassigned or whose owner text plausibly names them: the speaker label
 * ("You"), a bare "me", or any part of their email address ("dana@x.co",
 * "dana.smith", "dana", "smith"). Managed processing copies the owner
 * straight from diarization labels, so this is deliberately fuzzy.
 */
function ownerNamesFromEmail(email: string): string[] {
  const names = new Set(["you", "me", email.toLowerCase()]);
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local) {
    names.add(local);
    for (const part of local.split(/[._-]+/).filter(Boolean)) names.add(part);
  }
  return [...names];
}

interface Filters {
  status?: ActionStatus;
  mine?: boolean;
  overdue?: boolean;
  cursor?: string;
}

function parseFilters(raw: { status?: string; mine?: string; overdue?: string; cursor?: string }): Filters {
  const status: ActionStatus | undefined = raw.status === "open" || raw.status === "done" ? raw.status : undefined;
  return {
    status,
    mine: raw.mine === "1",
    overdue: raw.overdue === "1",
    cursor: raw.cursor || undefined,
  };
}

/**
 * Builds a filter link that flips one control while keeping the rest. A
 * control that is already active drops out of its own toggle link so it
 * can be clicked again to turn itself off.
 */
function filterHref(current: Filters, change: Partial<Filters>): string {
  const merged: Filters = {
    status: "status" in change ? change.status : current.status,
    mine: "mine" in change ? change.mine : current.mine,
    overdue: "overdue" in change ? change.overdue : current.overdue,
  };
  const params = new URLSearchParams();
  if (merged.status) params.set("status", merged.status);
  if (merged.mine) params.set("mine", "1");
  if (merged.overdue) params.set("overdue", "1");
  const query = params.toString();
  return query ? `/actions?${query}` : "/actions";
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  return { title: status === "open" ? "Open action items" : status === "done" ? "Completed action items" : "Action items" };
}

export default async function ActionItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; mine?: string; overdue?: string; cursor?: string }>;
}) {
  const session = await requireSession();
  const filters = parseFilters(await searchParams);
  const page = await listActionItems(session.workspaceId, {
    status: filters.status,
    overdue: filters.overdue,
    mine: filters.mine ? { userId: session.userId, names: ownerNamesFromEmail(session.email) } : undefined,
    cursor: filters.cursor,
  });

  const nextHref = page.nextCursor
    ? (() => {
        const params = new URLSearchParams();
        if (filters.status) params.set("status", filters.status);
        if (filters.mine) params.set("mine", "1");
        if (filters.overdue) params.set("overdue", "1");
        params.set("cursor", page.nextCursor);
        return `/actions?${params.toString()}`;
      })()
    : null;

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <Link href="/meetings" className="back-link">← Meetings</Link>
          <h1>Action items</h1>
        </div>
        <span className="total-count">{page.items.length} of {page.total} shown</span>
      </div>

      <nav className="filter-links" aria-label="Action item filters">
        <Link href={filterHref(filters, { status: undefined })} aria-current={!filters.status ? "page" : undefined}>All</Link>
        <Link href={filterHref(filters, { status: "open" })} aria-current={filters.status === "open" ? "page" : undefined}>Open</Link>
        <Link href={filterHref(filters, { status: "done" })} aria-current={filters.status === "done" ? "page" : undefined}>Done</Link>
        <Link href={filterHref(filters, { overdue: !filters.overdue })} aria-current={filters.overdue ? "page" : undefined}>Overdue</Link>
        <Link href={filterHref(filters, { mine: !filters.mine })} aria-current={filters.mine ? "page" : undefined}>Mine</Link>
      </nav>

      {page.items.length === 0 ? (
        <p className="empty-state">
          {filters.overdue
            ? "Nothing is overdue. Nice."
            : filters.status === "done"
              ? "No completed action items yet."
              : filters.mine
                ? "No action items assigned to you."
                : filters.status === "open"
                  ? "You are all caught up."
                  : "Action items from your meetings will appear here."}
        </p>
      ) : (
        <ul className="action-inbox" aria-label="Action items">
          {page.items.map((item) => (
            <ActionItemRow
              key={item.id}
              id={item.id}
              meetingId={item.meetingId}
              surface="actions"
              text={item.text}
              owner={item.owner}
              initialDone={item.status === "done"}
              initialDueAt={item.dueAt?.toISOString() ?? null}
              meeting={{ id: item.meeting.id, title: item.meeting.title, startedAt: item.meeting.startedAt.toISOString() }}
            />
          ))}
        </ul>
      )}

      {nextHref && (
        <nav className="pagination" aria-label="Pagination">
          <Link href={nextHref}>Next page →</Link>
        </nav>
      )}
    </div>
  );
}