"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { updateActionItemAction } from "@/app/meetings/[id]/actions";
import { dueDateInputValue, isOverdue } from "@/lib/actionItems";
import { LocalTime } from "./LocalTime";

type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * One action item that saves itself. Ticking the box or changing the due date
 * updates the row immediately and persists in the background; if the save
 * fails the row goes back to its last saved state and says why, right where
 * the reader is looking. There is no Save button and no redirect.
 */
export function ActionItemRow({
  id,
  meetingId,
  surface,
  text,
  owner,
  initialDone,
  initialDueAt,
  meeting,
}: {
  id: string;
  meetingId: string;
  surface: "meeting" | "actions";
  text: string;
  owner: string | null;
  initialDone: boolean;
  initialDueAt: string | null;
  /** Shown on the cross-meeting inbox, where the reader needs the context. */
  meeting?: { id: string; title: string; startedAt: string };
}) {
  const [done, setDone] = useState(initialDone);
  const [due, setDue] = useState(dueDateInputValue(initialDueAt));
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const lastSaved = useRef({ done: initialDone, due: dueDateInputValue(initialDueAt) });
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

  function save(next: { done: boolean; due: string }) {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setDone(next.done);
    setDue(next.due);
    setStatus({ kind: "saving" });
    const formData = new FormData();
    formData.set("id", id);
    formData.set("meetingId", meetingId);
    formData.set("surface", surface);
    formData.set("done", next.done ? "1" : "0");
    formData.set("dueAt", next.due);
    startTransition(async () => {
      let message: string | null = null;
      try {
        const result = await updateActionItemAction(formData);
        if (result.status === "error") message = result.message;
      } catch {
        message = "Couldn't save. Check your connection and try again.";
      }
      if (message === null) {
        lastSaved.current = next;
        setStatus({ kind: "saved" });
        fadeTimer.current = setTimeout(() => setStatus({ kind: "idle" }), 2_000);
      } else {
        setDone(lastSaved.current.done);
        setDue(lastSaved.current.due);
        setStatus({ kind: "error", message });
      }
    });
  }

  const overdue = isOverdue({ status: done ? "done" : "open", dueAt: due ? `${due}T00:00:00.000Z` : null });

  return (
    <li className={`action-row${done ? " is-done" : ""}`}>
      <input
        type="checkbox"
        className="action-check"
        checked={done}
        onChange={(event) => save({ done: event.target.checked, due })}
        aria-label={`Mark “${text}” ${done ? "not done" : "done"}`}
      />
      <div className="action-body">
        <div className="action-text">{text}</div>
        <div className="action-meta">
          {meeting && (
            <>
              <Link href={`/meetings/${meeting.id}`}>{meeting.title}</Link>
              <span aria-hidden="true"> · </span>
              <LocalTime iso={meeting.startedAt} style="date" />
            </>
          )}
          {owner && (
            <>
              {meeting && <span aria-hidden="true"> · </span>}
              <span>{owner}</span>
            </>
          )}
          {overdue && <span className="badge badge-failed">Overdue</span>}
        </div>
      </div>
      <div className="action-side">
        <label className="action-due">
          <span>Due</span>
          <input
            type="date"
            value={due}
            onChange={(event) => save({ done, due: event.target.value })}
            aria-label={`Due date for “${text}”`}
          />
        </label>
        <span className={`save-status${status.kind === "error" ? " is-error" : ""}`} role="status" aria-live="polite">
          {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : status.kind === "error" ? status.message : ""}
        </span>
      </div>
    </li>
  );
}
