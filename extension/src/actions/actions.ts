import { getMeeting, getSettings, listMeetings, updateMeeting } from "../lib/storage";
import { syncMeetingToWebapp } from "../lib/webappSync";
import { escapeHtml } from "../lib/html";
import type { ActionItem, ActionItemStatus, MeetingRecord } from "../types";
import { dueState, parseFilter, sortActionRows, type ActionRow, type DueState } from "./actionsModel";

const app = document.getElementById("app")!;

function showActionError(message: string): void {
  let error = document.getElementById("action-error");
  if (!error) {
    error = document.createElement("p");
    error.id = "action-error";
    error.className = "error-state action-error";
    error.setAttribute("role", "alert");
    app.prepend(error);
  }
  error.textContent = message;
}

function actionId(meeting: MeetingRecord, item: ActionItem, index: number): string {
  return item.id ?? `${meeting.id}-${index}`;
}

function formatDueDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

const DUE_LABELS: Record<DueState, string> = { none: "", upcoming: "", today: "Due today", overdue: "Overdue" };

/** Text, not just color, says why a row is highlighted. */
function dueBadgeHtml(state: DueState): string {
  return DUE_LABELS[state] ? `<span class="due-badge ${state}">${DUE_LABELS[state]}</span>` : "";
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

interface FocusHint {
  meetingId: string;
  actionId: string;
  position: number;
}

function restoreFocus(hint: FocusHint): void {
  const toggles = [...document.querySelectorAll<HTMLInputElement>(".action-toggle")];
  const same = toggles.find((input) => input.dataset.meetingId === hint.meetingId && input.dataset.actionId === hint.actionId);
  // The row may have left the filtered list (an open item marked done); land on the
  // row that took its place, or the heading when the list is now empty.
  (same ?? toggles[Math.min(hint.position, toggles.length - 1)] ?? document.querySelector<HTMLElement>("h1"))?.focus({ preventScroll: true });
}

async function render(focus?: FocusHint): Promise<void> {
  const filter = parseFilter(new URLSearchParams(window.location.search).get("status"));
  const now = new Date();
  const meetings = await listMeetings();
  const rows = sortActionRows(
    meetings.flatMap((meeting) =>
      meeting.actionItems.flatMap((item, index): ActionRow[] => {
        const status: ActionItemStatus = item.status ?? "open";
        if (filter !== "all" && status !== filter) return [];
        return [{ meeting, item, index, status }];
      }),
    ),
  );

  const emptyText = filter === "done" ? "No completed action items yet." : filter === "open" ? "Nothing open. You are all caught up." : "No action items yet. They appear here after a meeting is summarized.";

  app.innerHTML = `
    <header class="action-header">
      <h1 tabindex="-1">Action items</h1>
    </header>
    <nav class="action-filters" aria-label="Action item status">
      <a href="actions.html?status=all" aria-current="${filter === "all" ? "page" : "false"}">All</a>
      <a href="actions.html?status=open" aria-current="${filter === "open" ? "page" : "false"}">Open</a>
      <a href="actions.html?status=done" aria-current="${filter === "done" ? "page" : "false"}">Done</a>
    </nav>
    ${rows.length === 0 ? `<p class="empty-state">${emptyText}</p>` : `
      <ul class="action-list">
        ${rows.map(({ meeting, item, index, status }) => {
          const id = actionId(meeting, item, index);
          const state = dueState(status, item.dueAt, now);
          return `<li class="action-row ${status === "done" ? "done" : ""} ${state === "overdue" ? "overdue" : ""}">
            <input type="checkbox" class="action-toggle" data-meeting-id="${escapeHtml(meeting.id)}" data-action-id="${escapeHtml(id)}" ${status === "done" ? "checked" : ""} aria-label="Mark action item ${escapeHtml(item.text)} complete" />
            <div class="action-content">
              <p class="action-text">${escapeHtml(item.text)}</p>
              <div class="action-meta">
                <a href="../meeting/meeting.html?id=${encodeURIComponent(meeting.id)}">${escapeHtml(meeting.title)}</a>
                ${item.owner ? `<span>Owner: ${escapeHtml(item.owner)}</span>` : ""}
                <label>Due <input type="date" class="action-due" data-meeting-id="${escapeHtml(meeting.id)}" data-action-id="${escapeHtml(id)}" data-saved-value="${escapeHtml(formatDueDate(item.dueAt))}" value="${escapeHtml(formatDueDate(item.dueAt))}" /></label>
                <span class="due-slot">${dueBadgeHtml(state)}</span>
              </div>
            </div>
          </li>`;
        }).join("")}
      </ul>
    `}
  `;

  for (const input of document.querySelectorAll<HTMLInputElement>(".action-toggle")) {
    input.addEventListener("change", async () => {
      const position = [...document.querySelectorAll(".action-toggle")].indexOf(input);
      try {
        await setActionItem(input.dataset.meetingId!, input.dataset.actionId!, {
          status: input.checked ? "done" : "open",
          completedAt: input.checked ? new Date().toISOString() : null,
        });
        await render({ meetingId: input.dataset.meetingId!, actionId: input.dataset.actionId!, position });
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
        // Update the highlight in place: re-rendering here would move the row
        // (the list is sorted by due date) and drop the focused date field.
        const row = input.closest(".action-row");
        const done = row?.classList.contains("done") ?? false;
        const state = dueState(done ? "done" : "open", input.value, new Date());
        row?.classList.toggle("overdue", state === "overdue");
        const slot = row?.querySelector(".due-slot");
        if (slot) slot.innerHTML = dueBadgeHtml(state);
      } catch {
        input.value = input.dataset.savedValue ?? "";
        showActionError("Could not save the due date. Check the helper/webapp connection and try again.");
      }
    });
  }

  if (focus) restoreFocus(focus);
}

function renderFailure(): void {
  app.innerHTML = `
    <header class="action-header"><h1 tabindex="-1">Action items</h1></header>
    <p class="empty-state error-state" role="alert">Action items could not be loaded. Reopen this page and try again.</p>
  `;
}

void render().catch(renderFailure);
