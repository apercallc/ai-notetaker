import { deleteMeeting as deleteLocalMeeting, getMeeting, getSettings, updateMeeting } from "../lib/storage";
import { escapeHtml } from "../lib/html";
import { syncMeetingToWebapp } from "../lib/webappSync";
import { speakerLabel } from "../types";
import { formatOffset, transcriptIndexForBookmark } from "../lib/bookmarks";
import type { BackgroundToUiMessage } from "../lib/internalMessages";
import {
  displayTitle,
  exportAsMarkdown,
  exportAsPlainText,
  exportFileName,
  formatActionItemsForCopy,
  formatNotesForCopy,
  renderSummaryHtml,
  singleLine,
} from "./meetingView";

const app = document.getElementById("app")!;
let removeLiveListener: (() => void) | null = null;

/** How long "Delete meeting" can be undone before it is carried out. */
export const UNDO_DELETE_MS = 8_000;
let pendingDelete: number | null = null;

function showMeetingError(message: string): void {
  let error = document.getElementById("meeting-error");
  if (!error) {
    error = document.createElement("p");
    error.id = "meeting-error";
    error.className = "error-state meeting-error";
    error.setAttribute("role", "alert");
    app.prepend(error);
  }
  error.textContent = message;
}

function safeDriveLink(value: string | undefined): string {
  if (!value) return "#";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "docs.google.com" || url.hostname === "drive.google.com")
      ? escapeHtml(url.toString())
      : "#";
  } catch {
    return "#";
  }
}

function downloadText(meeting: { title: string }, content: string, extension: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName(meeting, extension);
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 0);
}

function titleRowHtml(title: string): string {
  return `<h1 id="meeting-title">${escapeHtml(title)}</h1>
    <button type="button" class="secondary" id="rename-title" aria-label="Rename meeting">Rename</button>`;
}

async function copyToClipboard(text: string, label: string): Promise<void> {
  const status = document.getElementById("copy-status");
  if (!status) return;
  try {
    await navigator.clipboard.writeText(text);
    status.className = "test-result valid";
    status.textContent = `${label} copied.`;
    window.setTimeout(() => {
      if (status.textContent === `${label} copied.`) {
        status.textContent = "";
        status.className = "test-result";
      }
    }, 3000);
  } catch {
    status.className = "test-result invalid";
    status.textContent = `Could not copy ${label.toLowerCase()}. Select the text and copy it manually.`;
  }
}

async function render(focusActionId?: string): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    app.innerHTML = `<p class="error-state" role="alert">No meeting specified.</p>`;
    return;
  }

  const meeting = await getMeeting(id);
  if (!meeting) {
    app.innerHTML = `<p class="error-state" role="alert">Meeting not found. It may have been deleted.</p>`;
    return;
  }

  removeLiveListener?.();
  removeLiveListener = null;

  const title = displayTitle(meeting);
  document.title = `${title} — AI Notetaker`;
  const hasActions = meeting.actionItems.length > 0;

  app.innerHTML = `
    <div class="title-row" id="title-row">${titleRowHtml(title)}</div>
    <p class="meeting-meta text-secondary">${new Date(meeting.startedAt).toLocaleString()}</p>
    ${meeting.driveExport?.status === "exported"
      ? `<p class="drive-export-status text-success" role="status">Saved to <a href="${safeDriveLink(meeting.driveExport.webViewLink)}" target="_blank" rel="noreferrer">Google Drive</a>.</p>`
      : meeting.driveExport?.status === "pending"
        ? `<p class="drive-export-status text-secondary" role="status">Saving notes to Google Drive…</p>`
        : meeting.driveExport?.status === "error"
          ? `<div class="drive-export-status" role="status"><p class="text-warning with-icon">Local meeting is safe, but Drive export failed: ${escapeHtml(meeting.driveExport.errorMessage ?? "unknown error")}.</p><button type="button" class="secondary" id="retry-drive-export">Retry Drive export</button></div>`
          : ""}

    <div class="note-actions" role="group" aria-label="Copy notes">
      <button type="button" class="secondary" id="copy-notes">Copy notes</button>
      <button type="button" class="secondary" id="copy-actions" ${hasActions ? "" : "disabled"}>Copy action items</button>
      <span class="test-result" id="copy-status" role="status" aria-live="polite"></span>
    </div>
    <div class="undo-bar" id="undo-bar" role="status" hidden></div>

    <section>
      <h2>Summary</h2>
      ${meeting.summary
        ? `<div class="summary">${renderSummaryHtml(meeting.summary, { hideActionItems: hasActions })}</div>`
        : meeting.status === "processing"
          ? `<p class="text-secondary">Still processing…</p>`
          : meeting.status === "error"
            ? `<p class="error-state meeting-error">Failed: ${escapeHtml(meeting.errorMessage ?? "unknown error")}</p>`
            : `<p class="text-secondary">No summary yet.</p>`}
      ${meeting.status === "error" && meeting.captureSource === "meet" ? `<button type="button" class="secondary" id="retry-processing">Retry saved Meet processing</button>` : ""}
    </section>

    <section>
      <h2>Action items</h2>
      ${
        hasActions
          ? `<ul class="action-items">${meeting.actionItems.map((item, index) => {
              const itemId = item.id ?? `${meeting.id}-${index}`;
              return `<li class="action-item ${item.status === "done" ? "done" : ""}">
                <input type="checkbox" class="action-toggle" data-action-id="${escapeHtml(itemId)}" ${item.status === "done" ? "checked" : ""} aria-label="Mark action item ${escapeHtml(item.text)} complete" />
                <span>${escapeHtml(item.text)}${item.owner ? ` <span class="text-secondary">(${escapeHtml(item.owner)})</span>` : ""}</span>
                <input type="date" class="action-due" data-action-id="${escapeHtml(itemId)}" data-saved-value="${escapeHtml(item.dueAt?.slice(0, 10) ?? "")}" value="${escapeHtml(item.dueAt?.slice(0, 10) ?? "")}" aria-label="Due date for ${escapeHtml(item.text)}" />
              </li>`;
            }).join("")}</ul>`
          : `<p class="text-secondary">None.</p>`
      }
    </section>

    ${
      meeting.bookmarks?.length
        ? `<section>
      <h2>Flagged moments</h2>
      <ul class="moments">${meeting.bookmarks
        .map(
          (bookmark) =>
            `<li><button type="button" class="moment" data-line="${transcriptIndexForBookmark(meeting, bookmark)}" aria-label="Jump to ${formatOffset(bookmark.offsetMs)} in the transcript"><span class="moment-time">${formatOffset(bookmark.offsetMs)}</span><span>${bookmark.note ? escapeHtml(bookmark.note) : "Flagged moment"}</span></button></li>`,
        )
        .join("")}</ul>
    </section>`
        : ""
    }

    <section>
      <h2>Transcript</h2>
      ${meeting.transcript.length > 0
        ? meeting.transcript
            .map(
              (segment, index) =>
                `<p class="transcript-line" id="line-${index}" tabindex="-1"><span class="speaker">${escapeHtml(speakerLabel(segment.speaker))}:</span>${escapeHtml(segment.text)}</p>`,
            )
            .join("")
        : `<p class="text-secondary">No transcript available.</p>`}
    </section>

    <div class="toolbar">
      <button class="secondary" id="export-markdown">Export as Markdown</button>
      <button class="secondary" id="export-plain-text">Export as text</button>
      <button class="secondary" id="print-meeting">Print / Save PDF</button>
      <button class="danger" id="delete-meeting">Delete meeting</button>
    </div>
  `;

  for (const button of document.querySelectorAll<HTMLButtonElement>(".moment")) {
    button.addEventListener("click", () => {
      const line = document.getElementById(`line-${button.dataset.line}`);
      if (!line) return;
      line.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      line.focus({ preventScroll: true });
      line.classList.add("transcript-line-highlight");
      window.setTimeout(() => line.classList.remove("transcript-line-highlight"), 2000);
    });
  }

  wireRename(id, title);

  document.getElementById("copy-notes")?.addEventListener("click", () => void copyToClipboard(formatNotesForCopy(meeting), "Notes"));
  document.getElementById("copy-actions")?.addEventListener("click", () => void copyToClipboard(formatActionItemsForCopy(meeting), "Action items"));

  document.getElementById("export-markdown")?.addEventListener("click", () => {
    downloadText(meeting, exportAsMarkdown(meeting), "md", "text/markdown");
  });
  document.getElementById("export-plain-text")?.addEventListener("click", () => {
    downloadText(meeting, exportAsPlainText(meeting), "txt", "text/plain");
  });
  document.getElementById("print-meeting")?.addEventListener("click", () => window.print());
  document.getElementById("retry-drive-export")?.addEventListener("click", async () => {
    const button = document.getElementById("retry-drive-export") as HTMLButtonElement;
    button.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "RETRY_DRIVE_EXPORT", meetingId: id });
      await render();
    } catch {
      showMeetingError("Drive export could not be retried. Your local meeting is still safe.");
      button.disabled = false;
    }
  });
  document.getElementById("retry-processing")?.addEventListener("click", async () => {
    const button = document.getElementById("retry-processing") as HTMLButtonElement;
    button.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "RETRY_MEETING_PROCESSING", meetingId: id });
      await render();
    } catch (error) {
      showMeetingError(error instanceof Error ? error.message : "Saved Meet processing could not be retried.");
      button.disabled = false;
    }
  });

  document.getElementById("delete-meeting")?.addEventListener("click", () => beginDelete(id));
  // A re-render (summary arrived, an item was ticked) must not silently drop a
  // pending delete's Undo control while its timer is still running.
  if (pendingDelete !== null) showUndoBar();

  for (const input of document.querySelectorAll<HTMLInputElement>(".action-toggle")) {
    input.addEventListener("change", async () => {
      try {
        const current = await getMeeting(id);
        if (!current) return;
        const updated = await updateMeeting(id, (record) => ({
          ...record,
          actionItems: record.actionItems.map((item, index) =>
            (item.id ?? `${record.id}-${index}`) === input.dataset.actionId
              ? { ...item, id: input.dataset.actionId, status: input.checked ? "done" : "open", completedAt: input.checked ? new Date().toISOString() : null }
              : item,
          ),
        }));
        if (updated) await syncMeetingToWebapp(updated, await getSettings());
        await render(input.dataset.actionId);
      } catch {
        input.checked = !input.checked;
        showMeetingError("Could not update this action item. Check the helper/webapp connection and try again.");
      }
    });
  }
  for (const input of document.querySelectorAll<HTMLInputElement>(".action-due")) {
    input.addEventListener("change", async () => {
      try {
        const updated = await updateMeeting(id, (record) => ({
          ...record,
          actionItems: record.actionItems.map((item, index) =>
            (item.id ?? `${record.id}-${index}`) === input.dataset.actionId
              ? { ...item, id: input.dataset.actionId, dueAt: input.value ? new Date(`${input.value}T00:00:00.000Z`).toISOString() : null }
              : item,
          ),
        }));
        if (updated) await syncMeetingToWebapp(updated, await getSettings());
        input.dataset.savedValue = input.value;
      } catch {
        input.value = input.dataset.savedValue ?? "";
        showMeetingError("Could not save the due date. Check the helper/webapp connection and try again.");
      }
    });
  }

  // Keep keyboard focus on the item the user just changed instead of dropping
  // it to <body> when the page re-renders.
  if (focusActionId) {
    [...document.querySelectorAll<HTMLInputElement>(".action-toggle")].find((input) => input.dataset.actionId === focusActionId)?.focus({ preventScroll: true });
  }

  // A meeting opened mid-summarization showed "Still processing…" forever
  // with no way to see the finished summary short of manually reloading
  // the tab (found in design review) — listen for the same SUMMARY_READY
  // event the popup already reacts to, and re-render once it lands.
  if (meeting.status === "processing") {
    function liveListener(message: BackgroundToUiMessage): void {
      if (message.type === "SUMMARY_READY" && message.meetingId === id) {
        removeLiveListener?.();
        removeLiveListener = null;
        void render().catch(renderFailure);
      }
      if (message.type === "DRIVE_EXPORT" && message.meetingId === id) {
        void render().catch(renderFailure);
      }
    }
    chrome.runtime.onMessage.addListener(liveListener);
    removeLiveListener = () => chrome.runtime.onMessage.removeListener(liveListener);
  }
}

/** Inline title editing: Enter saves, Escape cancels, and the text is stored as a single line. */
function wireRename(id: string, title: string): void {
  const row = document.getElementById("title-row");
  if (!row) return;
  const bindRename = (currentTitle: string): void => {
    document.getElementById("rename-title")?.addEventListener("click", () => {
      row.innerHTML = `
        <label class="sr-only" for="rename-input">Meeting title</label>
        <input type="text" id="rename-input" class="rename-input" maxlength="200" value="${escapeHtml(currentTitle)}" />
        <button type="button" class="primary" id="rename-save">Save</button>
        <button type="button" class="secondary" id="rename-cancel">Cancel</button>
      `;
      const input = document.getElementById("rename-input") as HTMLInputElement;
      input.focus();
      input.select();
      const restore = (nextTitle: string): void => {
        row.innerHTML = titleRowHtml(nextTitle);
        bindRename(nextTitle);
        document.getElementById("rename-title")?.focus();
      };
      const save = async (): Promise<void> => {
        const next = singleLine(input.value);
        if (!next || next === currentTitle) {
          restore(currentTitle);
          return;
        }
        try {
          const updated = await updateMeeting(id, (record) => ({ ...record, title: next }));
          if (!updated) throw new Error("missing");
          document.title = `${next} — AI Notetaker`;
          restore(next);
          void getSettings().then((settings) => syncMeetingToWebapp(updated, settings)).catch(() => {});
        } catch {
          showMeetingError("Could not rename this meeting. Try again.");
        }
      };
      document.getElementById("rename-save")?.addEventListener("click", () => void save());
      document.getElementById("rename-cancel")?.addEventListener("click", () => restore(currentTitle));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          restore(currentTitle);
        }
      });
    });
  };
  bindRename(title);
}

function showUndoBar(): void {
  const bar = document.getElementById("undo-bar");
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<span>This meeting will be deleted.</span><button type="button" class="secondary" id="undo-delete">Undo</button>`;
  document.getElementById("undo-delete")?.addEventListener("click", () => cancelDelete());
  app.classList.add("pending-delete");
  const deleteButton = document.getElementById("delete-meeting") as HTMLButtonElement | null;
  if (deleteButton) deleteButton.disabled = true;
}

function cancelDelete(): void {
  if (pendingDelete !== null) window.clearTimeout(pendingDelete);
  pendingDelete = null;
  const bar = document.getElementById("undo-bar");
  if (bar) {
    bar.hidden = true;
    bar.textContent = "";
  }
  app.classList.remove("pending-delete");
  const deleteButton = document.getElementById("delete-meeting") as HTMLButtonElement | null;
  if (deleteButton) {
    deleteButton.disabled = false;
    deleteButton.focus();
  }
}

/** Replaces the blocking confirm(): the delete is announced, undoable for a few seconds, then carried out. */
function beginDelete(id: string): void {
  if (pendingDelete !== null) return;
  pendingDelete = window.setTimeout(() => void commitDelete(id), UNDO_DELETE_MS);
  showUndoBar();
  document.getElementById("undo-delete")?.focus();
}

async function commitDelete(id: string): Promise<void> {
  pendingDelete = null;
  try {
    await chrome.runtime.sendMessage({ type: "DELETE_MEETING", meetingId: id });
  } catch {
    // The helper may be offline; local deletion remains authoritative for
    // the extension UI and can be retried for helper-owned raw audio.
  }
  try {
    await deleteLocalMeeting(id);
    removeLiveListener?.();
    removeLiveListener = null;
    app.classList.remove("pending-delete");
    app.innerHTML = `<p class="text-secondary" role="status">Meeting deleted. You can close this tab.</p>`;
    window.close();
  } catch {
    cancelDelete();
    showMeetingError("The meeting could not be deleted locally. Try again.");
  }
}

function renderFailure(): void {
  app.innerHTML = `
    <p class="error-state" role="alert">This meeting could not be loaded. It may have been deleted or local storage may be unavailable.</p>
  `;
}

void render().catch(renderFailure);
