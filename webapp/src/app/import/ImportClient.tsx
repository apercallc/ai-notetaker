"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  IMPORT_EXTENSIONS,
  IMPORT_MAX_BYTES,
  formatImportBytes,
  formatImportDuration,
  importAcceptAttribute,
  importFormatFromName,
} from "@/lib/importFormats";
import { PICKABLE_TEMPLATES } from "@/lib/noteTemplates";
import { LANGUAGES } from "@/lib/languages";

type Phase = "idle" | "uploading" | "finishing";
type Chosen = { file: File; durationSeconds: number | null };

const PARALLEL_CHUNKS = 3;
const CHUNK_ATTEMPTS = 4;
const BROWSER_HEADERS = { "x-notetaker-browser": "1" };

class ImportError extends Error {}

function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement(file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm|3gp)$/i.test(file.name) ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      clearTimeout(timer);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 6_000);
    element.preload = "metadata";
    element.onloadedmetadata = () => done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    element.onerror = () => done(null);
    element.src = url;
  });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ImportError("Importing needs a secure (https) connection.");
  const digest = await subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function errorFrom(response: Response): Promise<ImportError> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return new ImportError(body.error);
  } catch {
    // fall through to the generic message
  }
  return new ImportError(response.status === 401 ? "You were signed out. Sign in again and retry." : "The upload failed. Try again.");
}

/** Resumable per-file ids, so a reload or a retry continues the same upload instead of starting over. */
function resumeIds(file: File): { meetingId: string; idempotencyKey: string } {
  const storageKey = `import:${file.name}:${file.size}:${file.lastModified}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { meetingId?: string; idempotencyKey?: string } | null;
    if (saved?.meetingId && saved.idempotencyKey) return { meetingId: saved.meetingId, idempotencyKey: saved.idempotencyKey };
  } catch {
    // storage unavailable: fall back to fresh ids
  }
  const ids = { meetingId: crypto.randomUUID(), idempotencyKey: `import:${crypto.randomUUID()}` };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // resume is a convenience only
  }
  return ids;
}

function forgetIds(file: File) {
  try {
    sessionStorage.removeItem(`import:${file.name}:${file.size}:${file.lastModified}`);
  } catch {
    // ignore
  }
}

export function ImportClient({ maxSeconds, remainingSeconds }: { maxSeconds: number; remainingSeconds: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("general");
  const [language, setLanguage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== "idle";
  const estimateSeconds = chosen?.durationSeconds ?? null;
  const tooLong = estimateSeconds !== null && estimateSeconds > maxSeconds;
  const overBudget = estimateSeconds !== null && !tooLong && estimateSeconds > remainingSeconds;

  async function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!importFormatFromName(file.name)) {
      setChosen(null);
      setError(`That file type isn’t supported. Use ${IMPORT_EXTENSIONS.slice(0, 7).join(", ")} or a video such as mp4, mov or mkv.`);
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setChosen(null);
      setError(`That file is ${formatImportBytes(file.size)}. The limit is ${formatImportBytes(IMPORT_MAX_BYTES)}.`);
      return;
    }
    setChosen({ file, durationSeconds: null });
    const durationSeconds = await readDuration(file);
    setChosen((current) => (current?.file === file ? { file, durationSeconds } : current));
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!busy) void choose(event.dataTransfer.files[0]);
  }

  async function putChunk(uploadId: string, file: File, index: number, chunkBytes: number, signal: AbortSignal, directUpload = false) {
    const blob = file.slice(index * chunkBytes, Math.min(file.size, (index + 1) * chunkBytes));
    const buffer = await blob.arrayBuffer();
    const checksum = await sha256Hex(buffer);
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (directUpload) {
          const path = `/api/import/${uploadId}/chunks/${index}/direct`;
          const prepared = await fetch(path, { method: "POST", headers: { ...BROWSER_HEADERS, "content-type": "application/json" }, signal,
            body: JSON.stringify({ checksum, byteLength: buffer.byteLength, channel: "speaker" }) });
          if (!prepared.ok) {
            if (prepared.status < 500 && prepared.status !== 429 && prepared.status !== 408) throw await errorFrom(prepared);
            throw new Error("upload preparation failed");
          }
          const ticket = await prepared.json() as { replayed: boolean; url?: string };
          if (ticket.replayed) return;
          if (!ticket.url || new URL(ticket.url).protocol !== "https:") throw new ImportError("We couldn't upload your file. Try again to continue where it stopped.");
          const uploaded = await fetch(ticket.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
            body: buffer, signal, credentials: "omit", redirect: "error" });
          if (!uploaded.ok && uploaded.status !== 412) {
            if (uploaded.status < 500 && uploaded.status !== 429 && uploaded.status !== 408) throw new ImportError("We couldn't upload your file. Try again to continue where it stopped.");
            throw new Error("audio upload failed");
          }
          const completed = await fetch(path, { method: "POST", headers: { ...BROWSER_HEADERS, "content-type": "application/json" }, signal,
            body: JSON.stringify({ operation: "complete" }) });
          if (!completed.ok) {
            if (completed.status < 500 && completed.status !== 429 && completed.status !== 408) throw await errorFrom(completed);
            throw new Error("upload completion failed");
          }
          return;
        }
        const response = await fetch(`/api/import/${uploadId}/chunks/${index}`, {
          method: "PUT",
          headers: { ...BROWSER_HEADERS, "x-chunk-sha256": checksum, "content-type": "application/octet-stream" },
          body: buffer,
          signal,
        });
        if (response.ok) return;
        // 4xx other than a throttle will not improve on retry.
        if (response.status < 500 && response.status !== 429 && response.status !== 408) throw await errorFrom(response);
      } catch (cause) {
        if (cause instanceof ImportError || signal.aborted) throw cause;
      }
      if (attempt + 1 >= CHUNK_ATTEMPTS) throw new ImportError("We couldn't upload your file. Try again to continue where it stopped.");
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!chosen || busy || tooLong || overBudget) return;
    const { file } = chosen;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setProgress(0);
    setPhase("uploading");
    try {
      const ids = resumeIds(file);
      const begin = await fetch("/api/import", {
        method: "POST",
        headers: { ...BROWSER_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          ...ids,
          fileName: file.name,
          totalBytes: file.size,
          ...(chosen.durationSeconds ? { durationSeconds: Math.ceil(chosen.durationSeconds) } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          template,
          ...(language ? { language } : {}),
          recordedAtMs: file.lastModified,
        }),
        signal: controller.signal,
      });
      if (!begin.ok) throw await errorFrom(begin);
      const started = (await begin.json()) as { uploadId: string; meetingId: string; totalChunks: number; chunkBytes: number; receivedChunks: number[]; directUpload?: boolean };

      const received = new Set(started.receivedChunks);
      const pending = Array.from({ length: started.totalChunks }, (_, index) => index).filter((index) => !received.has(index));
      let done = received.size;
      setProgress(done / started.totalChunks);
      let failure: unknown = null;
      const workers = Array.from({ length: Math.min(PARALLEL_CHUNKS, pending.length) }, async () => {
        for (let next = pending.shift(); next !== undefined && !failure; next = pending.shift()) {
          try {
            await putChunk(started.uploadId, file, next, started.chunkBytes, controller.signal, started.directUpload === true);
            done += 1;
            setProgress(done / started.totalChunks);
          } catch (cause) {
            failure ??= cause;
            controller.abort();
          }
        }
      });
      await Promise.all(workers);
      if (failure) throw failure;

      setPhase("finishing");
      const finish = await fetch(`/api/import/${started.uploadId}/complete`, { method: "POST", headers: BROWSER_HEADERS });
      if (!finish.ok) throw await errorFrom(finish);
      forgetIds(file);
      router.push(`/meetings/${started.meetingId}`);
    } catch (cause) {
      setPhase("idle");
      if (controller.signal.aborted && !(cause instanceof ImportError)) setError("Upload stopped. Choose the file again to continue where it left off.");
      else setError(cause instanceof ImportError ? cause.message : "The upload failed. Try again.");
    }
  }

  function cancel() {
    abort.current?.abort();
  }

  return (
    <form className="import-form" onSubmit={start}>
      <label
        className={`import-drop${dragging ? " is-dragging" : ""}${busy ? " is-disabled" : ""}`}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept={importAcceptAttribute()}
          disabled={busy}
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        {chosen ? (
          <span className="import-file">
            <strong>{chosen.file.name}</strong>
            <span className="muted-copy">
              {formatImportBytes(chosen.file.size)}
              {estimateSeconds !== null ? ` · about ${formatImportDuration(estimateSeconds)}` : ""}
            </span>
          </span>
        ) : (
          <span className="import-prompt">
            <strong>Choose an audio or video file</strong>
            <span className="muted-copy">or drop it here · mp3, m4a, wav, mp4, mov, mkv and more · up to {formatImportBytes(IMPORT_MAX_BYTES)}</span>
          </span>
        )}
      </label>

      {chosen && (
        <div className="import-details">
          <label htmlFor="import-title">Title <span className="muted-copy">(optional — we’ll write one from the content)</span></label>
          <input id="import-title" className="text-input" type="text" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
          <label htmlFor="import-template">Notes template</label>
          <select id="import-template" className="text-input" value={template} onChange={(event) => setTemplate(event.target.value)} disabled={busy}>
            {PICKABLE_TEMPLATES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <p className="muted-copy">{PICKABLE_TEMPLATES.find((option) => option.id === template)?.description}</p>
          <label htmlFor="import-language">Spoken language</label>
          <select id="import-language" className="text-input" value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy}>
            <option value="">Detect automatically</option>
            {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
          <p className="muted-copy" role="status">
            {tooLong
              ? `This recording is longer than the ${formatImportDuration(maxSeconds)} your plan allows for one file.`
              : overBudget
                ? `This needs about ${formatImportDuration(estimateSeconds ?? 0)} but only ${formatImportDuration(remainingSeconds)} is left this period.`
                : estimateSeconds !== null
                  ? `Uses about ${formatImportDuration(estimateSeconds)} of your ${formatImportDuration(remainingSeconds)} left, plus one meeting. The exact length is measured after upload.`
                  : "The exact length is measured after upload and counted against your hosted hours, plus one meeting."}
          </p>
          <p className="muted-copy">Imported files have no separate microphone track, so speakers may not be labelled. The original file is deleted once your notes are ready.</p>
        </div>
      )}

      {busy && (
        <div className="import-progress" role="status" aria-live="polite">
          <progress max={1} value={phase === "finishing" ? 1 : progress} aria-label="Upload progress" />
          <span>{phase === "finishing" ? "Starting processing…" : `Uploading ${Math.round(progress * 100)}%`}</span>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="import-actions">
        <button type="submit" className="button button-primary" disabled={!chosen || busy || tooLong || overBudget}>
          {busy ? "Importing…" : "Import and summarize"}
        </button>
        {phase === "uploading" && <button type="button" className="button button-secondary" onClick={cancel}>Cancel</button>}
      </div>
    </form>
  );
}
