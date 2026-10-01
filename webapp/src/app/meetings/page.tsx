import Link from "next/link";
import type { Metadata } from "next";
import { listMeetings } from "@/lib/meetings";
import { MAX_SEARCH_LENGTH } from "@/lib/meetingConstants";
import { requireSession } from "@/lib/currentUser";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { getEntitlements } from "@/lib/usageLedger";
import { getRequestContext } from "@/lib/requestContext";
import { prisma } from "@/lib/db";
import { listFolders, purgeExpiredTrash } from "@/lib/library";
import { runIntegrationMaintenance } from "@/lib/integrations";
import { flattenFolders, folderPath, folderPathLabel, subtreeIds } from "@/lib/libraryTree";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Highlight } from "@/components/Highlight";
import { LocalTime } from "@/components/LocalTime";
import { OnboardingCard, type OnboardingPlan } from "@/components/OnboardingCard";
import { ProcessingBadge } from "@/components/ProcessingBadge";
import { RetryProcessing } from "@/components/RetryProcessing";
import { highlightParts } from "@/lib/snippet";
import { MEETING_RANGES, parseMeetingRange, rangeStart } from "@/lib/dateRange";
import { FolderRow } from "./FolderRow";
import { LibraryToolbar } from "./LibraryToolbar";
import { NoteActions } from "./NoteActions";
import { SearchForm } from "./SearchForm";

const PAGE_SIZE = 50;
// The data layer caps offsets at 100,000; keeping the UI bound aligned avoids
// issuing an expensive, guaranteed-to-fail query for a crafted page number.
const MAX_PAGE = 2_000;

type SearchParams = Promise<{ q?: string; page?: string; range?: string; error?: string; notice?: string; folder?: string; scope?: string }>;

function cleanQuery(raw: string | undefined): string | undefined {
  // Keep a pasted or hand-crafted URL from turning a normal page view into a
  // validation error; the API still rejects oversized queries explicitly.
  return raw?.trim().slice(0, MAX_SEARCH_LENGTH) || undefined;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const q = cleanQuery((await searchParams).q);
  return { title: q ? `Search: ${q}` : "Library" };
}

async function serviceOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const { protocol, host } = await getRequestContext();
  return `${protocol ?? "https"}://${host ?? "your-instance"}`;
}

const ERROR_TEXT: Record<string, string> = {
  "delete-failed": "That note could not be deleted. Try again.",
  "note-create-failed": "Couldn't create the note. Try again.",
};

export default async function MeetingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { userId, workspaceId } = await requireSession();
  const { q: rawQuery, page: rawPage, range: rawRange, error, notice, folder: rawFolder, scope } = await searchParams;
  const q = cleanQuery(rawQuery);
  const range = parseMeetingRange(rawRange);
  const since = rangeStart(range);
  const parsedPage = Number(rawPage ?? "1");
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= MAX_PAGE ? parsedPage : 1;

  // Self-hosted instances never run the worker that clears expired trash, so page loads do it (at most hourly).
  await purgeExpiredTrash().catch(() => undefined);
  // Same reason: retry any due "note ready" deliveries when there is no worker.
  void runIntegrationMaintenance().catch(() => undefined);
  const folders = await listFolders(workspaceId);
  const requestedFolder = rawFolder?.slice(0, 128);
  const currentFolder = requestedFolder ? folders.find((folder) => folder.id === requestedFolder) ?? null : null;
  const folderMissing = Boolean(requestedFolder) && !currentFolder;
  const crumbs = folderPath(folders, currentFolder?.id ?? null);

  // Browsing shows exactly one folder, like Drive. A search or date filter looks
  // through the current folder and everything inside it, or everywhere on request.
  const browsing = !q && !range;
  const searchAll = scope === "all";
  const listScope = browsing
    ? { folderId: currentFolder?.id ?? null }
    : currentFolder && !searchAll
      ? { folderIds: subtreeIds(folders, currentFolder.id) }
      : {};

  let result = await listMeetings(workspaceId, { query: q, since, ...listScope, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const { total } = result;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  if (currentPage !== page) {
    result = await listMeetings(workspaceId, { query: q, since, ...listScope, limit: PAGE_SIZE, offset: (currentPage - 1) * PAGE_SIZE });
  }
  const { meetings } = result;

  function hrefFor(next: { range?: string; page?: number; folder?: string | null; scope?: string; q?: string | null }): string {
    const params = new URLSearchParams();
    const folderId = next.folder === undefined ? currentFolder?.id : next.folder;
    const query = next.q === undefined ? q : next.q;
    if (folderId) params.set("folder", folderId);
    if (query) params.set("q", query);
    if (next.range) params.set("range", next.range);
    if (next.scope) params.set("scope", next.scope);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    return qs ? `/meetings?${qs}` : "/meetings";
  }
  const pageHref = (nextPage: number) => hrefFor({ range, page: nextPage, ...(searchAll ? { scope: "all" } : {}) });

  const rangeLabel = MEETING_RANGES.find((item) => item.id === range)?.label.toLowerCase();
  const noun = total === 1 ? "note" : "notes";
  const countText = (q ? `${total} ${total === 1 ? "result" : "results"} for “${q}”` : `${total} ${noun}`) + (rangeLabel ? `, ${rangeLabel}` : "");

  // Folder rows for the current level (browsing only), with what is inside each.
  const children = folders.filter((folder) => folder.parentId === (currentFolder?.id ?? null));
  let folderRows: { id: string; name: string; parentId: string | null; noteCount: number; subfolderCount: number; subtree: string[] }[] = [];
  if (browsing && children.length > 0) {
    const grouped = await prisma.meeting.groupBy({ by: ["folderId"], where: { workspaceId, deletedAt: null, folderId: { not: null } }, _count: { _all: true } });
    const perFolder = new Map(grouped.map((row) => [row.folderId, row._count._all]));
    folderRows = children.map((folder) => {
      const subtree = subtreeIds(folders, folder.id);
      return {
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        noteCount: subtree.reduce((sum, id) => sum + (perFolder.get(id) ?? 0), 0),
        subfolderCount: subtree.length - 1,
        subtree,
      };
    });
  }
  const flatFolders = flattenFolders(folders);
  const managed = managedHostingEnabled();

  let onboarding: React.ReactNode = null;
  if (total === 0 && folderRows.length === 0 && !q && !range && !currentFolder && !folderMissing) {
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
        <h1>Library</h1>
        <p className="total-count" role="status" aria-live="polite">{countText}</p>
      </div>

      <LibraryToolbar folderId={currentFolder?.id ?? null} canImport={managed} />

      {(currentFolder || folderMissing) && (
        <nav className="breadcrumbs" aria-label="Folder path">
          <ol>
            <li><Link href="/meetings">Library</Link></li>
            {crumbs.map((crumb, index) => (
              <li key={crumb.id}>
                {index === crumbs.length - 1 ? <span aria-current="page">{crumb.name}</span> : <Link href={hrefFor({ folder: crumb.id })}>{crumb.name}</Link>}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {folderMissing && <p className="error-text" role="alert">That folder isn’t available. It may have been moved to Trash.</p>}

      <SearchForm initialQuery={q ?? ""} range={range} folderId={currentFolder?.id} scope={searchAll ? "all" : undefined} />
      <nav className="filter-chips" aria-label="Filter by date">
        <Link href={hrefFor({ ...(searchAll ? { scope: "all" } : {}) })} aria-current={range ? undefined : "true"}>All time</Link>
        {MEETING_RANGES.map((item) => (
          <Link key={item.id} href={hrefFor({ range: item.id, ...(searchAll ? { scope: "all" } : {}) })} aria-current={range === item.id ? "true" : undefined}>{item.label}</Link>
        ))}
      </nav>
      {currentFolder && !browsing && (
        <p className="muted-copy search-scope">
          Searching {searchAll ? "everywhere" : <>in <strong>{currentFolder.name}</strong> and its folders</>}.{" "}
          <Link href={hrefFor(searchAll ? {} : { scope: "all", ...(range ? { range } : {}) })}>{searchAll ? `Search only in ${currentFolder.name}` : "Search everywhere"}</Link>
        </p>
      )}

      {error && <p className="error-text" role="alert">{ERROR_TEXT[error] ?? "That request was invalid."}</p>}
      {notice === "trashed" && (
        <p className="callout" role="status">Moved to Trash. <Link href="/trash">Open Trash</Link> to restore it within 30 days.</p>
      )}

      {folderRows.length > 0 && (
        <ul className="folder-list" aria-label="Folders">
          {folderRows.map((folder) => (
            <FolderRow
              key={folder.id}
              id={folder.id}
              name={folder.name}
              parentId={folder.parentId}
              href={hrefFor({ folder: folder.id, scope: undefined, range: undefined })}
              noteCount={folder.noteCount}
              subfolderCount={folder.subfolderCount}
              folders={flatFolders}
              excludeIds={folder.subtree}
            />
          ))}
        </ul>
      )}

      {meetings.length === 0 ? (
        onboarding ?? (
          folderRows.length > 0 ? null : (
            <div className="empty-state">
              <p>
                {q
                  ? `No notes match “${q}”${rangeLabel ? ` in the ${rangeLabel}` : ""}.`
                  : currentFolder
                    ? "This folder is empty. Create a note, upload a .md or .txt file, or move notes here."
                    : "No notes in this period."}
              </p>
              {(q || range) && <Link href={hrefFor({ q: null, ...(searchAll ? { scope: "all" } : {}) })}>Clear filters</Link>}
            </div>
          )
        )
      ) : (
        <ul className="meeting-list">
          {meetings.map((meeting) => (
            <li key={meeting.id} className="meeting-card">
              <div className="title">
                <Link href={`/meetings/${meeting.id}`} className="card-link">
                  {q ? <Highlight parts={highlightParts(meeting.title, q)} /> : meeting.title}
                </Link>
                <span className="file-type" title="Markdown note">.md</span>
              </div>
              <div className="meta">
                <LocalTime iso={meeting.startedAt} />
                {!browsing && meeting.folderId && <span> · {folderPathLabel(folders, meeting.folderId)}</span>}
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
              <div className="card-actions">
                {meeting.processing?.status === "error" && <RetryProcessing meetingId={meeting.id} />}
                <NoteActions id={meeting.id} title={meeting.title} folderId={meeting.folderId} folders={flatFolders} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="pagination" aria-label="Note pages">
          {currentPage > 1 ? <Link href={pageHref(currentPage - 1)}>← Newer</Link> : <span aria-hidden="true" />}
          <span aria-current="page">Page {currentPage} of {totalPages}</span>
          {currentPage < totalPages ? <Link href={pageHref(currentPage + 1)}>Older →</Link> : <span aria-hidden="true" />}
        </nav>
      )}
    </div>
  );
}
