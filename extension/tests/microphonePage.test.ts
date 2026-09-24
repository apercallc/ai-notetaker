import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubMedia(result: "granted" | "denied" | "missing"): { stop: ReturnType<typeof vi.fn> } {
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (result === "denied") throw new DOMException("Permission denied", "NotAllowedError");
        if (result === "missing") throw new DOMException("Requested device not found", "NotFoundError");
        return { getTracks: () => [track] };
      }),
    },
  });
  return track;
}

async function load(): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = `<main id="app"></main>`;
  await import("../src/meet/microphone");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("microphone permission page", () => {
  it("confirms the grant and releases the microphone immediately", async () => {
    const track = stubMedia("granted");
    await load();

    expect(document.querySelector("h1")?.textContent).toBe("Microphone allowed");
    expect(track.stop).toHaveBeenCalled();
  });

  it("explains how to unblock a denied microphone and lets the user retry", async () => {
    stubMedia("denied");
    await load();
    expect(document.querySelector("h1")?.textContent).toBe("Chrome blocked the microphone");

    stubMedia("granted");
    document.getElementById("retry")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("h1")?.textContent).toBe("Microphone allowed");
  });

  it("says so when there is no microphone at all", async () => {
    stubMedia("missing");
    await load();
    expect(document.querySelector("h1")?.textContent).toBe("No microphone found");
  });
});
