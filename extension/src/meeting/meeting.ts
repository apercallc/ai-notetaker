import { deleteMeeting as deleteLocalMeeting, getMeeting, getSettings, updateMeeting } from "../lib/storage";
import { escapeHtml } from "../lib/html";
import { syncMeetingToWebapp } from "../lib/webappSync";
import { speakerLabel } from "../types";

const app = document.getElementById("app")!;

function showMeetingError(message: string): void {
  let error = document.getElementById("meeting-error");
  if (!error) {
    error = document.createElement("p");
    error.id = "meeting-error";
    error.className = "text-warning";
    error.setAttribute("role", "alert");
    app.prepend(error);
  }
  error.textContent = message;
}

function exportAsMarkdown(meeting: NonNullable<Awaited<ReturnType<typeof getMeeting>>>): string {
  const lines = [
    `# ${meeting.title}`,
    "",
    `Started: ${meeting.startedAt}`,
    "",
    "## Summary",
    meeting.summary ?? "_No summary available._",
    "",
    "## Action Items",
    ...(meeting.actionItems.length > 0
      ? meeting.actionItems.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.text}${item.owner ? ` (${item.owner})` : ""}${item.dueAt ? ` — due ${item.dueAt.slice(0, 10)}` : ""}`)
      : ["_None_"]),
    "",
    "## Transcript",
    ...meeting.transcript.map((segment) => `**${speakerLabel(segment.speaker)}:** ${segment.text}`),
  ];
  return lines.join("\n");
}

function exportAsPlainText(meeting: NonNullable<Awaited<ReturnType<typeof getMeeting>>>): string {
  const lines = [
    meeting.title,
    `Started: ${new Date(meeting.startedAt).toLocaleString()}`,
    "",
    "SUMMARY",
    meeting.summary ?? "No summary available.",
    "",
    "ACTION ITEMS",
    ...(meeting.actionItems.length > 0
      ? meeting.actionItems.map((item) => `${item.status === "done" ? "[done]" : "[open]"} ${item.text}${item.owner ? ` (${item.owner})` : ""}${item.dueAt ? ` — due ${item.dueAt.slice(0, 10)}` : ""}`)
      : ["None"]),
    "",
    "TRANSCRIPT",
    ...meeting.transcript.map((segment) => `${speakerLabel(segment.speaker)}: ${segment.text}`),
  ];
  return lines.join("\n");
}

function downloadText(meeting: NonNullable<Awaited<ReturnType<typeof getMeeting>>>, content: string, extension: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${meeting.title.replace(/[^a-z0-9]+/gi, "-") || "meeting"}.${extension}`;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 0);
}

async function render(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (!id) {
    app.innerHTML = `<p>No meeting specified.</p>`;
    return;
  }

  const meeting = await getMeeting(id);
  if (!meeting) {
    app.innerHTML = `<p>Meeting not found. It may have been deleted.</p>`;
    return;
  }

  app.innerHTML = `
    <h1>${escapeHtml(meeting.title)}</h1>
    <p class="meeting-meta text-secondary">${new Date(meeting.startedAt).toLocaleString()}</p>

    <section>
      <h2>Summary</h2>
      <p>${meeting.summary ? escapeHtml(meeting.summary) : meeting.status === "processing" ? "Still processing…" : meeting.status === "error" ? `Failed: ${escapeHtml(meeting.errorMessage ?? "unknown error")}` : "No summary yet."}</p>
    </section>

    <section>
      <h2>Action items</h2>
      ${
        meeting.actionItems.length > 0
          ? `<ul class="action-items">${meeting.actionItems.map((item, index) => {
              const id = item.id ?? `${meeting.id}-${index}`;
              return `<li class="action-item ${item.status === "done" ? "done" : ""}">
                <input type="checkbox" class="action-toggle" data-action-id="${escapeHtml(id)}" ${item.status === "done" ? "checked" : ""} aria-label="Mark action item ${escapeHtml(item.text)} complete" />
                <span>${escapeHtml(item.text)}${item.owner ? ` <span class="text-secondary">(${escapeHtml(item.owner)})</span>` : ""}</span>
                <input type="date" class="action-due" data-action-id="${escapeHtml(id)}" data-saved-value="${escapeHtml(item.dueAt?.slice(0, 10) ?? "")}" value="${escapeHtml(item.dueAt?.slice(0, 10) ?? "")}" aria-label="Due date for ${escapeHtml(item.text)}" />
              </li>`;
            }).join("")}</ul>`
          : `<p class="text-secondary">None.</p>`
      }
    </section>

    <section>
      <h2>Transcript</h2>
      ${meeting.transcript.length > 0
        ? meeting.transcript
            .map(
              (segment) =>
                `<p class="transcript-line"><span class="speaker">${escapeHtml(speakerLabel(segment.speaker))}:</span>${escapeHtml(segment.text)}</p>`,
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

  document.getElementById("export-markdown")?.addEventListener("click", () => {
    downloadText(meeting, exportAsMarkdown(meeting), "md", "text/markdown");
  });
  document.getElementById("export-plain-text")?.addEventListener("click", () => {
    downloadText(meeting, exportAsPlainText(meeting), "txt", "text/plain");
  });
  document.getElementById("print-meeting")?.addEventListener("click", () => window.print());

  document.getElementById("delete-meeting")?.addEventListener("click", async () => {
    if (!confirm("Delete this meeting? This can't be undone.")) return;
    try {
      await chrome.runtime.sendMessage({ type: "DELETE_MEETING", meetingId: id });
    } catch {
      // The helper may be offline; local deletion remains authoritative for
      // the extension UI and can be retried for helper-owned raw audio.
    }
    try {
      await deleteLocalMeeting(id);
      window.close();
    } catch {
      showMeetingError("The meeting could not be deleted locally. Try again.");
    }
  });

  for (const input of document.querySelectorAll<HTMLInputElement>(".action-toggle")) {
    input.addEventListener("change", async () => {
      try {
        const current = await getMeeting(id);
        if (!current) return;
        const updated = await updateMeeting(id, (meeting) => ({
          ...meeting,
          actionItems: meeting.actionItems.map((item, index) =>
            (item.id ?? `${meeting.id}-${index}`) === input.dataset.actionId
              ? { ...item, id: input.dataset.actionId, status: input.checked ? "done" : "open", completedAt: input.checked ? new Date().toISOString() : null }
              : item,
          ),
        }));
        if (updated) await syncMeetingToWebapp(updated, await getSettings());
        await render();
      } catch {
        input.checked = !input.checked;
        showMeetingError("Could not update this action item. Check the helper/webapp connection and try again.");
      }
    });
  }
  for (const input of document.querySelectorAll<HTMLInputElement>(".action-due")) {
    input.addEventListener("change", async () => {
      try {
        const updated = await updateMeeting(id, (meeting) => ({
          ...meeting,
          actionItems: meeting.actionItems.map((item, index) =>
            (item.id ?? `${meeting.id}-${index}`) === input.dataset.actionId
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
}

function renderFailure(): void {
  app.innerHTML = `
    <p class="text-warning" role="alert">This meeting could not be loaded. It may have been deleted or local storage may be unavailable.</p>
  `;
}

void render().catch(renderFailure);
