import { normalizeWebappUrl } from "./providerTest";
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
): Promise<void> {
  const webapp = settings?.webapp;
  if (!webapp) return;
  const normalized = normalizeWebappUrl(webapp.url);
  if (!normalized) return;
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
  } catch {
    console.warn(`Failed to sync meeting ${meeting.id} to webapp`);
  } finally {
    clearTimeout(timeoutId);
  }
}
