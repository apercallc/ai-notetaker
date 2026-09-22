import { normalizeWebappUrl } from "./providerTest";
import { getWebappSyncOutbox, queueWebappSync, removeWebappSyncOutbox } from "./storage";
import type { MeetingRecord, NotetakerSettings } from "../types";

const WEBAPP_SYNC_TIMEOUT_MS = 15_000;

/**
 * Syncs one finished meeting to the user's own authenticated webapp. Local
 * storage remains authoritative: a failed optional sync is never surfaced as
 * a failed recording.
 */
export async function syncMeetingToWebapp(
  meeting: MeetingRecord,
  settings: Pick<NotetakerSettings, "webapp"> | null | undefined,
  fetchImpl: typeof fetch = fetch,
  options: { queueOnFailure?: boolean } = {},
): Promise<boolean> {
  const webapp = settings?.webapp;
  if (!webapp) return false;
  const normalized = normalizeWebappUrl(webapp.url);
  if (!normalized) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBAPP_SYNC_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${normalized}/api/meetings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${webapp.token}`,
      },
      body: JSON.stringify({
        id: meeting.id,
        title: meeting.title,
        mode: meeting.mode ?? "general",
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        transcript: meeting.transcript,
        summary: meeting.summary ?? "",
        actionItems: meeting.actionItems.map((item) => ({
          id: item.id,
          text: item.text,
          owner: item.owner,
          status: item.status ?? "open",
          dueAt: item.dueAt ?? null,
          completedAt: item.completedAt ?? null,
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`webapp returned HTTP ${response.status}`);
    await removeWebappSyncOutbox(meeting.id);
    return true;
  } catch {
    console.warn(`Failed to sync meeting ${meeting.id} to webapp`);
    if (options.queueOnFailure !== false) await queueWebappSync(meeting);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function flushWebappSyncOutbox(
  settings: Pick<NotetakerSettings, "webapp"> | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!settings?.webapp) return;
  for (const meeting of await getWebappSyncOutbox()) {
    await syncMeetingToWebapp(meeting, settings, fetchImpl, { queueOnFailure: false });
  }
}
