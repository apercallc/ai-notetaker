export type SyncPillState = "local" | "synced" | "offline";

export interface SyncPill {
  state: SyncPillState;
  label: string;
  title: string;
}

/**
 * The popup's sync pill. Without a connected web app nothing syncs, so the pill
 * invites sign-in instead of looking like a fault; once connected, recordings
 * waiting in the outbox (or no network) turn it red.
 */
export function syncPill(connected: boolean, waiting: number, online: boolean): SyncPill {
  if (!connected) return { state: "local", label: "Local only", title: "Recordings stay on this computer. Sign in to sync notes across devices." };
  if (waiting > 0 || !online) {
    const detail = waiting > 0 ? `${waiting} recording${waiting === 1 ? "" : "s"} waiting to sync. ` : "";
    return { state: "offline", label: "Offline", title: `${detail}Click to retry.` };
  }
  return { state: "synced", label: "Synced", title: "Notes are syncing to your web app." };
}
