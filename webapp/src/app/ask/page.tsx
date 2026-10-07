import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/currentUser";
import { hostedAiEnabled } from "@/lib/deploymentConfig";
import { managedHostingEnabled } from "@/lib/managedAuth";
import { getChatEntitlement } from "@/lib/chatQuota";
import { MAX_QUESTION_LENGTH } from "@/lib/notesChatContext";
import { listFolders } from "@/lib/library";
import { flattenFolders } from "@/lib/libraryTree";
import { AskClient } from "./AskClient";

export const metadata = { title: "Ask your notes" };
export const dynamic = "force-dynamic";

export default async function AskPage() {
  const { workspaceId } = await requireSession();
  if (!managedHostingEnabled()) notFound();
  if (!hostedAiEnabled()) redirect("/meetings");
  const entitlement = await getChatEntitlement(workspaceId);
  const folders = flattenFolders(await listFolders(workspaceId));

  return (
    <div className="container">
      <div className="page-header">
        <h1>Ask your notes</h1>
        {entitlement.limit > 0 && (
          <p className="total-count">{entitlement.remaining} of {entitlement.limit} questions left this period</p>
        )}
      </div>
      {entitlement.eligible ? (
        <AskClient maxLength={MAX_QUESTION_LENGTH} folders={folders.map((folder) => ({ id: folder.id, label: `${"\u2003".repeat(folder.depth)}${folder.name}` }))} />
      ) : (
        <section className="settings-card">
          <h2>{entitlement.reason === "limit" ? "You've used this period's questions" : "Chat with your meetings"}</h2>
          <p className="muted-copy">
            {entitlement.reason === "limit"
              ? "Your question allowance resets with your billing period."
              : "Ask questions across every meeting and get answers with links to the notes they came from. Included with Pro and Team."}
          </p>
          <Link className="button button-primary" href="/billing">See plans</Link>
        </section>
      )}
    </div>
  );
}
