import { describe, expect, it } from "vitest";
import { syncPill } from "../src/lib/syncPill";

describe("syncPill", () => {
  it("is neutral until a web app is connected", () => {
    expect(syncPill(false, 3, false).state).toBe("local");
  });

  it("is synced when connected, online and the outbox is empty", () => {
    expect(syncPill(true, 0, true)).toMatchObject({ state: "synced", label: "Synced" });
  });

  it("is offline when the outbox has recordings waiting", () => {
    const pill = syncPill(true, 2, true);
    expect(pill.state).toBe("offline");
    expect(pill.title).toContain("2 recordings waiting");
  });

  it("is offline when the browser has no network", () => {
    expect(syncPill(true, 0, false).state).toBe("offline");
  });
});
