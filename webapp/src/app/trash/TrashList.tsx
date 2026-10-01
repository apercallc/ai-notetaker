"use client";

import { FileText, Folder } from "lucide-react";
import { useState, useTransition } from "react";
import { LocalTime } from "@/components/LocalTime";
import { deleteForeverAction, emptyTrashAction, restoreAction, type TrashResult } from "./actions";

interface Item {
  kind: "folder" | "note";
  id: string;
  name: string;
  daysLeft: number;
  noteCount: number;
  folderCount: number;
  deletedAtIso: string;
}

export function TrashList({ items, canEmpty }: { items: Item[]; canEmpty: boolean }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: (formData: FormData) => Promise<TrashResult>, fields: Record<string, string>, busy: string) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    setMessage(null);
    setBusyId(busy);
    startTransition(async () => {
      let result: TrashResult;
      try {
        result = await action(formData);
      } catch {
        result = { ok: false, error: "Something went wrong. Try again." };
      }
      setBusyId(null);
      setMessage(result.ok ? { kind: "ok", text: result.message } : { kind: "error", text: result.error });
    });
  }

  function describe(item: Item): string {
    if (item.kind === "note") return "Note";
    const notes = item.noteCount === 1 ? "1 note" : `${item.noteCount} notes`;
    return item.folderCount > 1 ? `Folder · ${notes} · ${item.folderCount - 1 === 1 ? "1 subfolder" : `${item.folderCount - 1} subfolders`}` : `Folder · ${notes}`;
  }

  return (
    <div className="trash">
      {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {items.length === 0 ? (
        <div className="empty-state"><p>The trash is empty.</p></div>
      ) : (
        <>
          <ul className="meeting-list">
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="meeting-card trash-row">
                <div className="title trash-title">
                  {item.kind === "folder" ? <Folder size={18} strokeWidth={1.75} aria-hidden="true" /> : <FileText size={18} strokeWidth={1.75} aria-hidden="true" />}
                  <span>{item.name}</span>
                </div>
                <div className="meta">
                  {describe(item)} · deleted <LocalTime iso={item.deletedAtIso} style="date" /> · {item.daysLeft === 1 ? "1 day" : `${item.daysLeft} days`} left
                </div>
                <div className="card-actions">
                  <button type="button" className="button button-secondary button-small" disabled={pending} aria-busy={busyId === item.id} aria-label={`Restore ${item.name}`} onClick={() => run(restoreAction, { kind: item.kind, id: item.id }, item.id)}>Restore</button>
                  <button
                    type="button"
                    className="button button-danger button-small"
                    disabled={pending}
                    aria-label={`Delete ${item.name} forever`}
                    onClick={() => {
                      const what = item.kind === "folder" ? `"${item.name}" and everything in it` : `"${item.name}"`;
                      if (window.confirm(`Delete ${what} forever? This can't be undone.`)) run(deleteForeverAction, { kind: item.kind, id: item.id }, item.id);
                    }}
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {canEmpty && (
            <button
              type="button"
              className="button button-danger"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Empty the trash? Everything in it is deleted forever and can't be restored.")) run(() => emptyTrashAction(), {}, "all");
              }}
            >
              {busyId === "all" ? "Emptying…" : "Empty trash"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
