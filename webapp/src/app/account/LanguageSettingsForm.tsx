"use client";

import { useState, useTransition, type FormEvent } from "react";
import { LANGUAGES, MAX_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH } from "@/lib/languages";
import { updateLanguageSettingsAction } from "./languageActions";

export function LanguageSettingsForm({ vocabulary, summaryLanguage, canEdit }: { vocabulary: string; summaryLanguage: string; canEdit: boolean }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    startTransition(async () => {
      const result = await updateLanguageSettingsAction(formData).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
      setMessage(result.ok ? { kind: "ok", text: result.message } : { kind: "error", text: result.error });
    });
  }

  return (
    <form className="integration-form" onSubmit={onSubmit}>
      <label htmlFor="lang-vocabulary">Names and terms</label>
      <textarea id="lang-vocabulary" name="vocabulary" className="text-input" rows={6} defaultValue={vocabulary} disabled={!canEdit || pending}
        placeholder={"Acme Corp\nKubernetes\nDr. Nguyen"} />
      <p className="muted-copy">One per line, up to {MAX_VOCABULARY_TERMS} terms of {MAX_VOCABULARY_TERM_LENGTH} characters. The transcriber listens for them and the notes spell them exactly. Applies to new recordings and imports.</p>
      <label htmlFor="lang-summary">Write notes in</label>
      <select id="lang-summary" name="summaryLanguage" className="text-input" defaultValue={summaryLanguage} disabled={!canEdit || pending}>
        <option value="">Same as the conversation</option>
        {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      <p className="muted-copy">Choose a language to have every new summary written in it, whatever language was spoken.</p>
      {canEdit ? (
        <div className="integration-actions">
          <button type="submit" className="button button-primary button-small" disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</button>
        </div>
      ) : (
        <p className="muted-copy">Ask a workspace owner to change these.</p>
      )}
      {message && <p className={message.kind === "error" ? "error-text" : "muted-copy"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    </form>
  );
}
