"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { SummaryBlocks } from "@/components/SummaryBlocks";
import { parseSummary } from "@/lib/summaryFormat";
import { MAX_NOTE_BODY } from "@/lib/noteEditing.shared";
import { restorePreviousBodyAction, saveNoteBodyAction } from "./actions";

/**
 * The note's text. Reading shows the formatted notes (passed in from the
 * server); Edit switches to a plain Markdown text editor with a preview. There
 * is no rich-text mode: what you type is what is stored. Saving refuses to
 * overwrite a note that changed underneath you, and the replaced text is kept
 * once so it can be restored.
 */
export function NoteBody({
  meetingId,
  summary,
  version,
  hasPrevious,
  startEditing,
  children,
}: {
  meetingId: string;
  summary: string;
  version: string;
  hasPrevious: boolean;
  startEditing: boolean;
  /** The server-rendered formatted notes. */
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(summary);
  const [preview, setPreview] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(version);
  const [seenVersion, setSeenVersion] = useState(version);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = editing && draft !== summary;

  // A newer version arriving from the server (after a save elsewhere) replaces ours.
  if (seenVersion !== version) {
    setSeenVersion(version);
    setCurrentVersion(version);
  }

  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function save() {
    const formData = new FormData();
    formData.set("meetingId", meetingId);
    formData.set("body", draft);
    formData.set("version", currentVersion);
    setMessage(null);
    startTransition(async () => {
      let result;
      try {
        result = await saveNoteBodyAction(formData);
      } catch {
        result = { status: "error" as const, message: "Something went wrong. Your text is still here; try again." };
      }
      if (result.status === "saved") {
        setCurrentVersion(result.version);
        setEditing(false);
        setPreview(false);
        setMessage({ kind: "ok", text: "Saved." });
      } else {
        setMessage({ kind: "error", text: result.message });
      }
    });
  }

  function restore() {
    const formData = new FormData();
    formData.set("meetingId", meetingId);
    setMessage(null);
    startTransition(async () => {
      let result;
      try {
        result = await restorePreviousBodyAction(formData);
      } catch {
        result = { status: "error" as const, message: "Something went wrong. Try again." };
      }
      if (result.status === "saved") {
        setCurrentVersion(result.version);
        setMessage({ kind: "ok", text: "Switched to the earlier version. Restore again to switch back." });
      } else {
        setMessage({ kind: "error", text: result.message });
      }
    });
  }

  function cancel() {
    if (dirty && !window.confirm("Discard your changes?")) return;
    setDraft(summary);
    setEditing(false);
    setPreview(false);
    setMessage(null);
  }

  if (!editing) {
    return (
      <div className="note-body">
        <div className="note-body-tools">
          <button type="button" className="button button-secondary button-small" onClick={() => { setDraft(summary); setEditing(true); setMessage(null); }}>
            Edit text
          </button>
          {hasPrevious && (
            <button type="button" className="button button-secondary button-small" onClick={restore} disabled={pending} aria-busy={pending}>
              {pending ? "Restoring…" : "Restore earlier version"}
            </button>
          )}
        </div>
        {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
        {children}
      </div>
    );
  }

  return (
    <div className="note-body note-editor-wrap">
      <div className="note-body-tools" role="group" aria-label="Editor view">
        <button type="button" className="button button-secondary button-small" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className="button button-secondary button-small" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
        <span className="muted-copy note-count">{draft.length.toLocaleString("en-US")} / {MAX_NOTE_BODY.toLocaleString("en-US")}</span>
      </div>
      {preview ? (
        draft.trim() ? <SummaryBlocks blocks={parseSummary(draft)} /> : <p className="muted-copy">Nothing to preview yet.</p>
      ) : (
        <>
          <label className="sr-only" htmlFor="note-text">Note text (Markdown)</label>
          <textarea
            ref={textarea}
            id="note-text"
            className="text-input note-editor"
            value={draft}
            maxLength={MAX_NOTE_BODY}
            spellCheck
            placeholder="Write in Markdown: # headings, - bullets, plain paragraphs."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (dirty && !pending) save();
              }
            }}
            disabled={pending}
          />
        </>
      )}
      {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      <div className="note-body-tools">
        <button type="button" className="button button-primary button-small" onClick={save} disabled={pending || !dirty} aria-busy={pending}>{pending ? "Saving…" : "Save"}</button>
        <button type="button" className="button button-secondary button-small" onClick={cancel} disabled={pending}>Cancel</button>
        {dirty && <span className="muted-copy">Unsaved changes</span>}
      </div>
    </div>
  );
}
