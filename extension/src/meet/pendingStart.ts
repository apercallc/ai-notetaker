/**
 * The one unavoidable step of Meet capture: Chrome only grants tab capture
 * after the user has invoked the extension on that tab — a toolbar click or
 * the keyboard shortcut. A content-script click (the in-call widget's Start)
 * can never be that first invocation.
 *
 * So the widget's blocked start is not the end of the flow: it is remembered
 * here, and the toolbar click that opens the popup *is* the invocation — the
 * popup consumes the pending intent and starts the notes itself, on that
 * same click. One click total, in the order Chrome allows.
 *
 * chrome.storage.session has exactly the right lifetime: the intent dies with
 * the browser session (a stale intent from yesterday's call must never
 * auto-start today's), and survives the MV3 service worker being killed
 * between the widget's failed start and the popup's open.
 */

const PENDING_START_KEY = "notetaker.pendingMeetStart";

export interface PendingMeetStart {
  /** The Meet tab whose capture was blocked. */
  tabId: number;
  /** Chosen notes style, so the auto-start matches what the user picked in the widget. */
  meetingMode?: string;
  /** The call's name when the widget knew it. */
  titleHint?: string;
}

export async function savePendingMeetStart(intent: PendingMeetStart): Promise<void> {
  try {
    await chrome.storage.session.set({ [PENDING_START_KEY]: intent });
  } catch {
    // Best-effort by design: without the handoff the widget's own hint still
    // tells the user what to do.
  }
}

export async function takePendingMeetStart(): Promise<PendingMeetStart | null> {
  try {
    const items = (await chrome.storage.session.get(PENDING_START_KEY)) as Record<string, unknown>;
    const intent = items[PENDING_START_KEY] as PendingMeetStart | undefined;
    if (!intent || typeof intent !== "object" || typeof intent.tabId !== "number") {
      // A malformed entry is discarded, not merely skipped: leaving it would
      // make every future popup open re-read the same poison.
      if (intent !== undefined) await chrome.storage.session.remove(PENDING_START_KEY);
      return null;
    }
    await chrome.storage.session.remove(PENDING_START_KEY);
    return intent;
  } catch {
    return null;
  }
}

/**
 * A successful start on a tab makes any remembered handoff for it moot — the
 * person completed the flow another way (the keyboard shortcut starts notes
 * directly), and a leftover intent must never auto-start a second recording
 * the next time the popup opens idle.
 */
export async function clearPendingMeetStartFor(tabId: number): Promise<void> {
  try {
    const items = (await chrome.storage.session.get(PENDING_START_KEY)) as Record<string, unknown>;
    const intent = items[PENDING_START_KEY] as PendingMeetStart | undefined;
    if (intent?.tabId === tabId) await chrome.storage.session.remove(PENDING_START_KEY);
  } catch {
    // Best-effort: a leftover intent is discarded when the popup next opens.
  }
}