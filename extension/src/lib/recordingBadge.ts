/**
 * The toolbar badge is the only thing visible while the person is looking at
 * the call: "REC" while a recording is live, "!" when one failed and they were
 * not looking at the place that reported it.
 */
export type BadgeState = "" | "REC" | "!";

const COLORS: Record<Exclude<BadgeState, "">, string> = {
  REC: "#c62828",
  "!": "#c62828", // matches --color-danger-solid
};

export function setBadge(state: BadgeState): void {
  if (!chrome.action) return;
  if (state) void chrome.action.setBadgeBackgroundColor({ color: COLORS[state] });
  void chrome.action.setBadgeText({ text: state });
}
