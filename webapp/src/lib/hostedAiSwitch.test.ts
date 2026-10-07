import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedAiDisabledError } from "./entitlementError";
import { reserveChatQuestion } from "./chatQuota";
import { reserveMeetingProcessing } from "./usageLedger";

afterEach(() => vi.unstubAllEnvs());

describe("hosted AI is off unless an operator opts in", () => {
  it("refuses to reserve meeting processing or a chat question", async () => {
    vi.stubEnv("HOSTED_AI_ENABLED", "false");
    await expect(reserveMeetingProcessing("workspace", "key", 0)).rejects.toBeInstanceOf(HostedAiDisabledError);
    await expect(reserveChatQuestion("workspace")).rejects.toThrow(/not available/i);
  });
});
