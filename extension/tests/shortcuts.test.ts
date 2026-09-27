import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "./setup";
import { NO_SHORTCUTS, readShortcuts, shortcutKeys } from "../src/lib/shortcuts";

afterEach(() => {
  Object.assign(chromeMock, { commands: undefined });
});

describe("readShortcuts", () => {
  it("returns the bindings Chrome actually assigned", async () => {
    Object.assign(chromeMock, {
      commands: { getAll: vi.fn(async () => [
        { name: "_execute_action", shortcut: "" },
        { name: "toggle-recording", shortcut: "Alt+Shift+R" },
        { name: "add-bookmark", shortcut: "" },
      ]) },
    });
    expect(await readShortcuts()).toEqual({ toggle: "Alt+Shift+R", bookmark: "" });
  });

  it("reports no shortcuts when the API is missing or fails", async () => {
    expect(await readShortcuts()).toEqual(NO_SHORTCUTS);
    Object.assign(chromeMock, { commands: { getAll: vi.fn(async () => { throw new Error("nope"); }) } });
    expect(await readShortcuts()).toEqual(NO_SHORTCUTS);
  });
});

describe("shortcutKeys", () => {
  it("splits Windows/Linux and macOS notations into keycaps", () => {
    expect(shortcutKeys("Alt+Shift+R")).toEqual(["Alt", "Shift", "R"]);
    expect(shortcutKeys("Ctrl+Shift+Comma")).toEqual(["Ctrl", "Shift", "Comma"]);
    expect(shortcutKeys("⌥⇧R")).toEqual(["⌥", "⇧", "R"]);
    expect(shortcutKeys("")).toEqual([]);
  });
});
