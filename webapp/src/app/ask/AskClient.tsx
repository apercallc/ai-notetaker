"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { askNotesAction, type AskResult } from "./actions";

type Source = { n: number; id: string; title: string; startedAt: string };
type Turn = { id: number; question: string; answer?: string; sources?: Source[]; error?: string };

const SUGGESTIONS = [
  "What action items are still open?",
  "What did we decide about pricing?",
  "Summarize my most recent meeting",
];

/** Turns [1] markers into links to the matching source note. */
function Answer({ text, sources }: { text: string; sources: Source[] }) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <p className="ask-answer">
      {parts.map((part, index) => {
        const match = /^\[(\d{1,2})\]$/.exec(part);
        const source = match ? sources.find((item) => item.n === Number(match[1])) : undefined;
        return source ? (
          <Link key={index} className="ask-cite" href={`/meetings/${source.id}`} aria-label={`Source ${source.n}: ${source.title}`}>{part}</Link>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </p>
  );
}

export function AskClient({ maxLength }: { maxLength: number }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const nextId = useRef(1);
  const router = useRouter();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  function ask(question: string, replaceId?: number) {
    const text = question.trim();
    if (!text || pending) return;
    const id = nextId.current++;
    setTurns((current) => [...current.filter((turn) => turn.id !== replaceId), { id, question: text }]);
    setDraft("");
    textarea.current?.focus();
    startTransition(async () => {
      let result: AskResult;
      try {
        result = await askNotesAction(text);
      } catch {
        result = { ok: false, error: "Something went wrong. Try again." };
      }
      setTurns((current) =>
        current.map((turn) =>
          turn.id !== id ? turn : result.ok ? { ...turn, answer: result.answer, sources: result.sources } : { ...turn, error: result.error },
        ),
      );
      end.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      // Keep the "questions left" counter in the page header honest.
      router.refresh();
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // On touch devices Enter is the only way to start a new line; send with the button instead.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
      event.preventDefault();
      ask(draft);
    }
  }

  return (
    <div className="ask">
      <div className="ask-thread" aria-live="polite" aria-busy={pending}>
        {turns.length === 0 && (
          <div className="ask-empty">
            <p className="muted-copy">Ask anything about your meetings. Answers come only from your notes, with links back to them.</p>
            <div className="filter-chips ask-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="ask-chip" onClick={() => ask(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="ask-turn">
            <p className="ask-question">{turn.question}</p>
            {turn.answer ? (
              <div className="ask-reply">
                <Answer text={turn.answer} sources={turn.sources ?? []} />
                {turn.sources && turn.sources.length > 0 && (
                  <ul className="ask-sources" aria-label="Sources">
                    {turn.sources.map((source) => (
                      <li key={source.n}>
                        <Link href={`/meetings/${source.id}`}>[{source.n}] {source.title}</Link>
                        <span className="muted-copy"> · {new Date(source.startedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : turn.error ? (
              <div role="alert">
                <p className="error-text">{turn.error}</p>
                <button type="button" className="button button-secondary" onClick={() => ask(turn.question, turn.id)} disabled={pending}>Try again</button>
              </div>
            ) : (
              <p className="muted-copy" role="status">Searching your notes…</p>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>

      <form className="ask-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="ask-input">Your question</label>
        <textarea
          ref={textarea}
          id="ask-input"
          className="text-input ask-input"
          rows={2}
          maxLength={maxLength}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your meetings…"
          enterKeyHint="send"
        />
        <button type="submit" className="button button-primary" disabled={pending || !draft.trim()}>
          {pending ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
