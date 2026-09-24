export interface Shortcuts {
  /** Empty when Chrome has no binding (the default is only a suggestion). */
  toggle: string;
  bookmark: string;
}

export const NO_SHORTCUTS: Shortcuts = { toggle: "", bookmark: "" };

/** The bindings Chrome actually assigned; a suggested key can be left unassigned. */
export async function readShortcuts(): Promise<Shortcuts> {
  try {
    if (!chrome.commands?.getAll) return NO_SHORTCUTS;
    const commands = await chrome.commands.getAll();
    const find = (name: string): string => commands.find((command) => command.name === name)?.shortcut ?? "";
    return { toggle: find("toggle-recording"), bookmark: find("add-bookmark") };
  } catch {
    return NO_SHORTCUTS;
  }
}

/** `Alt+Shift+R` and macOS `⌥⇧R` both split into individual keycaps. */
export function shortcutKeys(shortcut: string): string[] {
  if (!shortcut) return [];
  return shortcut.includes("+") ? shortcut.split("+").filter(Boolean) : Array.from(shortcut);
}
