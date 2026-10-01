import Link from "next/link";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { requireSession } from "@/lib/currentUser";
import { TRASH_RETENTION_DAYS, countTrashRoots, listTrash, purgeExpiredTrash } from "@/lib/library";
import { TrashList } from "./TrashList";

export const metadata = { title: "Trash" };
export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const { workspaceId, role } = await requireSession();
  if (!managedHostingEnabled()) await purgeExpiredTrash().catch(() => undefined);
  const items = await listTrash(workspaceId);
  const total = items.length >= 500 ? await countTrashRoots(workspaceId) : items.length;

  return (
    <div className="container">
      <nav className="breadcrumbs" aria-label="Folder path">
        <ol>
          <li><Link href="/meetings">Library</Link></li>
          <li><span aria-current="page">Trash</span></li>
        </ol>
      </nav>
      <div className="page-header">
        <h1>Trash</h1>
        <p className="total-count">{items.length === 1 ? "1 item" : `${items.length} items`}</p>
      </div>
      <p className="muted-copy">Deleted notes and folders stay here for {TRASH_RETENTION_DAYS} days, then are removed for good. Deleting forever removes them now.</p>
      {total > items.length && (
        <p className="muted-copy" role="status">Showing the {items.length} most recent of {total} items. Older ones are still here and are removed on schedule; delete some to see more.</p>
      )}
      <TrashList
        canEmpty={role === "owner"}
        items={items.map((item) => ({
          kind: item.kind,
          id: item.id,
          name: item.name,
          daysLeft: item.daysLeft,
          noteCount: item.noteCount,
          folderCount: item.folderCount,
          deletedAtIso: item.deletedAt.toISOString(),
        }))}
      />
    </div>
  );
}
