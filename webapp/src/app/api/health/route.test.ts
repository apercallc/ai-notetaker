import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalManagedHosting = process.env.MANAGED_HOSTING;
const originalAppUrl = process.env.APP_URL;

afterEach(() => {
  if (originalManagedHosting === undefined) delete process.env.MANAGED_HOSTING;
  else process.env.MANAGED_HOSTING = originalManagedHosting;
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

describe("GET /api/health", () => {
  it("keeps the self-hosted liveness response backward compatible", async () => {
    delete process.env.MANAGED_HOSTING;
    expect(await (await GET()).json()).toEqual({ ok: true });
  });

  it("reports managed readiness without returning secret values", async () => {
    process.env.MANAGED_HOSTING = "true";
    process.env.APP_URL = "https://notes.example.com";
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: "managed", managedReady: false, objectStorage: "filesystem" });
  });
});
