import { getMeeting, getSettings, listMeetings, updateMeeting } from "../lib/storage";
import { syncMeetingToWebapp } from "../lib/webappSync";
import { escapeHtml } from "../lib/html";
import type { ActionItem, ActionItemStatus, MeetingRecord } from "../types";

const app = document.getElementById("app")!;

function showActionError(message: string): void {
  let error = document.getElementById("action-error");
  if (!error) {
    error = document.createElement("p");
    error.id = "action-error";
    error.className = "empty-state error-state";
    error.setAttribute("role", "alert");
    app.prepend(error);
  }
  error.textContent = message;
}

type Filter = "all" | ActionItemStatus;

function actionId(meeting: MeetingRecord, item: ActionItem, index: number): string {
  return item.id ?? `${meeting.id}-${index}`;
}

function formatDueDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

async function setActionItem(meetingId: string, id: string, changes: Partial<ActionItem>): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  const updated = await updateMeeting(meetingId, (current) => ({
    ...current,
    actionItems: current.actionItems.map((item, index) =>
      actionId(current, item, index) === id ? { ...item, ...changes, id } : item,
    ),
  }));
  if (updated) await syncMeetingToWebapp(updated, await getSettings());
}

async function render(): Promise<void> {
  const filter = (new URLSearchParams(window.location.search).get("status") as Filter | null) ?? "all";
  const meetings = await listMeetings();
  const rows = meetings.flatMap((meeting) =>
    meeting.actionItems.flatMap((item, index) => {
      const status = item.status ?? "open";
      if (filter !== "all" && status !== filter) return [];
      return [{ meeting, item, index, status }];
    }),
  );

  app.innerHTML = `
    <header class="action-header">
      <h1>Action items</h1>
      <a href="../popup/popup.html">Record</a>
    </header>
    <nav class="action-filters" aria-label="Action item status">
      <a href="actions.html?status=all" aria-current="${filter === "all" ? "page" : "false"}">All</a>
      <a href="actions.html?status=open" aria-current="${filter === "open" ? "page" : "false"}">Open</a>
      <a href="actions.html?status=done" aria-current="${filter === "done" ? "page" : "false"}">Done</a>
    </nav>
    ${rows.length === 0 ? `<p class="empty-state">${filter === "done" ? "No completed action items yet." : "No action items here."}</p>` : `
      <ul class="action-list">
        ${rows.map(({ meeting, item, index, status }) => {
          const id = actionId(meeting, item, index);
          return `<li class="action-row ${status === "done" ? "done" : ""}">
            <input type="checkbox" class="action-toggle" data-meeting-id="${escapeHtml(meeting.id)}" data-action-id="${escapeHtml(id)}" ${status === "done" ? "checked" : ""} aria-label="Mark action item ${escapeHtml(item.text)} complete" />
            <div class="action-content">
              <p class="action-text">${escapeHtml(item.text)}</p>
              <div class="action-meta">
                <a href="../meeting/meeting.html?id=${encodeURIComponent(meeting.id)}">${escapeHtml(meeting.title)}</a>
                ${item.owner ? `<span>Owner: ${escapeHtml(item.owner)}</span>` : ""}
                <label>Due <input type="date" class="action-due" data-meeting-id="${escapeHtml(meeting.id)}" data-action-id="${escapeHtml(id)}" data-saved-value="${escapeHtml(formatDueDate(item.dueAt))}" value="${escapeHtml(formatDueDate(item.dueAt))}" /></label>
              </div>
            </div>
          </li>`;
        }).join("")}
      </ul>
    `}
  `;

  for (const input of document.querySelectorAll<HTMLInputElement>(".action-toggle")) {
    input.addEventListener("change", async () => {
      try {
        await setActionItem(input.dataset.meetingId!, input.dataset.actionId!, {
          status: input.checked ? "done" : "open",
          completedAt: input.checked ? new Date().toISOString() : null,
        });
        await render();
      } catch {
        input.checked = !input.checked;
        showActionError("Could not update this action item. Check the helper/webapp connection and try again.");
      }
    });
  }
  for (const input of document.querySelectorAll<HTMLInputElement>(".action-due")) {
    input.addEventListener("change", async () => {
      try {
        await setActionItem(input.dataset.meetingId!, input.dataset.actionId!, {
          dueAt: input.value ? new Date(`${input.value}T00:00:00.000Z`).toISOString() : null,
        });
        input.dataset.savedValue = input.value;
      } catch {
        input.value = input.dataset.savedValue ?? "";
        showActionError("Could not save the due date. Check the helper/webapp connection and try again.");
      }
    });
  }
}

function renderFailure(): void {
  app.innerHTML = `
    <header class="action-header"><h1>Action items</h1><a href="../popup/popup.html">Record</a></header>
    <p class="empty-state error-state" role="alert">Action items could not be loaded. Reopen this page and try again.</p>
  `;
}

void render().catch(renderFailure);
