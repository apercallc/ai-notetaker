import Link from "next/link";
import { requireSession } from "@/lib/currentUser";
import { AUDIT_CATEGORIES, auditActors, auditLogAvailable, isAuditCategory, listAuditEvents } from "@/lib/auditLog";
import { AUDIT_RETENTION_DAYS } from "@/lib/audit";
import { LocalTime } from "@/components/LocalTime";

export const metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ category?: string; actor?: string; cursor?: string }> }) {
  const session = await requireSession();
  const { category, actor, cursor } = await searchParams;
  const back = <Link href="/team" className="back-link">← Team</Link>;

  if (session.role !== "owner") {
    return <div className="container">{back}<p className="empty-state">Only a workspace owner can see the activity log.</p></div>;
  }
  if (!(await auditLogAvailable(session.workspaceId))) {
    return (
      <div className="container">
        {back}
        <section className="settings-card">
          <h2>Activity log</h2>
          <p className="muted-copy">See who changed what in your workspace: members, notes, folders, sharing, integrations and tokens. Included with Hosted Team.</p>
          <Link className="button button-primary" href="/billing">See plans</Link>
        </section>
      </div>
    );
  }

  const filters = { ...(isAuditCategory(category) ? { category } : {}), ...(actor ? { actor: actor.slice(0, 64) } : {}) };
  const [{ rows, nextCursor }, actors] = await Promise.all([listAuditEvents(session.workspaceId, filters, cursor), auditActors(session.workspaceId)]);
  const exportQuery = new URLSearchParams({ ...(filters.category ? { category: filters.category } : {}), ...(filters.actor ? { actor: filters.actor } : {}) }).toString();
  const nextQuery = nextCursor ? new URLSearchParams({ ...(filters.category ? { category: filters.category } : {}), ...(filters.actor ? { actor: filters.actor } : {}), cursor: nextCursor }).toString() : null;

  return (
    <div className="container">
      {back}
      <div className="page-header">
        <h1>Activity log</h1>
        <a className="button button-secondary button-small" href={`/team/audit/export${exportQuery ? `?${exportQuery}` : ""}`}>Download CSV</a>
      </div>
      <p className="muted-copy">Who changed what, newest first. Entries are kept for {AUDIT_RETENTION_DAYS} days. They record that something happened, never the text of a note.</p>

      <form method="get" className="audit-filters">
        <label htmlFor="audit-category">Show</label>
        <select id="audit-category" name="category" className="text-input" defaultValue={filters.category ?? ""}>
          <option value="">Everything</option>
          {AUDIT_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <label htmlFor="audit-actor">By</label>
        <select id="audit-actor" name="actor" className="text-input" defaultValue={filters.actor ?? ""}>
          <option value="">Anyone</option>
          <option value="system">System</option>
          {actors.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}
        </select>
        <button type="submit" className="button button-secondary button-small">Filter</button>
      </form>

      {rows.length === 0 ? (
        <div className="empty-state"><p>No activity matches.</p></div>
      ) : (
        <div className="audit-table-wrap" role="region" aria-label="Activity log" tabIndex={0}>
          <table className="audit-table">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><LocalTime iso={row.at.toISOString()} /></td>
                  <td>{row.actor}</td>
                  <td>
                    {row.label}
                    {row.targetTitle && row.targetId && <> — <Link href={`/meetings/${row.targetId}`}>{row.targetTitle}</Link></>}
                    {row.details && <div className="muted-copy">{row.details}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextQuery && <p><Link href={`/team/audit?${nextQuery}`}>Older activity →</Link></p>}
      {rows.length > 0 && !nextQuery && <p className="muted-copy">That&apos;s everything.</p>}
    </div>
  );
}
