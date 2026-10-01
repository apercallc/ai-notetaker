import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "./setup";
import { sendToBackground } from "../src/lib/sendToBackground";

beforeEach(() => chromeMock.reset());

describe("sendToBackground", () => {
  it("returns the worker's reply", async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({ meetingId: "m1" });
    await expect(sendToBackground({ type: "START_RECORDING" })).resolves.toEqual({ meetingId: "m1" });
  });

  it("returns an empty or missing reply untouched", async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue(undefined);
    await expect(sendToBackground({ type: "X" })).resolves.toBeUndefined();
  });

  it("turns the worker's failure envelope into a rejection", async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({ error: "storage is full" });
    await expect(sendToBackground({ type: "SAVE_SETTINGS" })).rejects.toThrow("storage is full");
  });

  it("keeps a reply that carries data next to an error field", async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({ valid: false, error: "bad key" });
    await expect(sendToBackground({ type: "TEST_PROVIDER_KEY" })).resolves.toEqual({ valid: false, error: "bad key" });
  });

  it("propagates a closed channel", async () => {
    chromeMock.runtime.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await expect(sendToBackground({ type: "GET_STATE" })).rejects.toThrow("Receiving end");
  });
});
