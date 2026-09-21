import { deleteMeeting, getMeeting } from "../lib/storage";
import { escapeHtml } from "../lib/html";
import { speakerLabel } from "../types";

const app = document.getElementById("app")!;

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
      ? meeting.actionItems.map((item) => `- [ ] ${item.text}${item.owner ? ` (${item.owner})` : ""}`)
      : ["_None_"]),
    "",
    "## Transcript",
    ...meeting.transcript.map((segment) => `**${speakerLabel(segment.speaker)}:** ${segment.text}`),
  ];
  return lines.join("\n");
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
          ? `<ul class="action-items">${meeting.actionItems.map((item) => `<li>${escapeHtml(item.text)}${item.owner ? ` <span class="text-secondary">(${escapeHtml(item.owner)})</span>` : ""}</li>`).join("")}</ul>`
          : `<p class="text-secondary">None.</p>`
      }
    </section>

    <section>
      <h2>Transcript</h2>
      ${meeting.transcript
        .map(
          (segment) =>
            `<p class="transcript-line"><span class="speaker">${escapeHtml(speakerLabel(segment.speaker))}:</span>${escapeHtml(segment.text)}</p>`,
        )
        .join("")}
    </section>

    <div class="toolbar">
      <button class="secondary" id="export-markdown">Export as Markdown</button>
      <button class="danger" id="delete-meeting">Delete meeting</button>
    </div>
  `;

  document.getElementById("export-markdown")?.addEventListener("click", () => {
    const blob = new Blob([exportAsMarkdown(meeting)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${meeting.title.replace(/[^a-z0-9]+/gi, "-")}.md`;
    link.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("delete-meeting")?.addEventListener("click", async () => {
    if (!confirm("Delete this meeting? This can't be undone.")) return;
    await deleteMeeting(id);
    window.close();
  });
}

void render();
