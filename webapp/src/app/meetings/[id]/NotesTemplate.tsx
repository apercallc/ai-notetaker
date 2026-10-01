"use client";

import { useState, useTransition } from "react";
import { regenerateNotesAction } from "./actions";
import { MAX_NOTES_REGENERATIONS, PICKABLE_TEMPLATES } from "@/lib/noteTemplates";
import { LANGUAGES } from "@/lib/languages";

/**
 * Pick a template and rewrite the notes from the stored transcript. Two steps
 * (choose, then confirm) because it replaces the summary text.
 */
export function NotesTemplate({ meetingId, mode, used, edited, defaultLanguage }: { meetingId: string; mode: string; used: number; edited: boolean; defaultLanguage: string }) {
  const initial = PICKABLE_TEMPLATES.some((template) => template.id === mode) ? mode : "general";
  const [template, setTemplate] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [language, setLanguage] = useState(defaultLanguage);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [remaining, setRemaining] = useState(Math.max(0, MAX_NOTES_REGENERATIONS - used));
  const [pending, startTransition] = useTransition();

  function run() {
    setMessage(null);
    const formData = new FormData();
    formData.set("meetingId", meetingId);
    formData.set("template", template);
    formData.set("summaryLanguage", language);
    startTransition(async () => {
      let result;
      try {
        result = await regenerateNotesAction(formData);
      } catch {
        result = { status: "error" as const, message: "Something went wrong. Try again." };
      }
      setConfirming(false);
      if (result.status === "done") {
        setRemaining(result.remaining);
        setMessage({ kind: "ok", text: "Notes rewritten." });
      } else {
        setMessage({ kind: "error", text: result.message });
      }
    });
  }

  const description = PICKABLE_TEMPLATES.find((option) => option.id === template)?.description;

  return (
    <div className="notes-template">
      <div className="notes-template-row">
        <label htmlFor="notes-template-select">Notes template</label>
        <select id="notes-template-select" className="text-input" value={template} onChange={(event) => { setTemplate(event.target.value); setConfirming(false); setMessage(null); }} disabled={pending}>
          {PICKABLE_TEMPLATES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <label htmlFor="notes-language">Write in</label>
        <select id="notes-language" className="text-input" value={language} onChange={(event) => { setLanguage(event.target.value); setConfirming(false); setMessage(null); }} disabled={pending}>
          <option value="">Same as the conversation</option>
          {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
        {!confirming && (
          <button type="button" className="button button-secondary button-small" onClick={() => setConfirming(true)} disabled={pending || remaining === 0}>
            Regenerate notes
          </button>
        )}
      </div>
      <p className="muted-copy">{description} {remaining > 0 ? `${remaining} of ${MAX_NOTES_REGENERATIONS} rewrites left for this meeting.` : "No rewrites left for this meeting."}</p>
      {confirming && (
        <div className="callout" role="group" aria-label="Confirm rewriting the notes">
          <p>Rewrite the summary with the {PICKABLE_TEMPLATES.find((option) => option.id === template)?.label} template? Your action items are kept; new ones are added.{edited ? " This replaces the text you edited; you can restore it afterwards." : " The current text is kept so you can restore it."}</p>
          <div className="inline-action">
            <button type="button" className="button button-primary button-small" onClick={run} disabled={pending} aria-busy={pending}>{pending ? "Rewriting…" : "Rewrite notes"}</button>
            <button type="button" className="button button-secondary button-small" onClick={() => setConfirming(false)} disabled={pending}>Cancel</button>
          </div>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    </div>
  );
}
