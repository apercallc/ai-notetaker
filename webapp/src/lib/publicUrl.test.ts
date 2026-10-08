import { describe, expect, it } from "vitest";
import { ownOrigin, publicUrl } from "./publicUrl";

const internal = new Request("https://0.0.0.0:8080/api/v1/meetings");

describe("publicUrl / ownOrigin", () => {
  it("uses APP_URL on managed hosting, never the internal request address", () => {
    const env = { MANAGED_HOSTING: "true", APP_URL: "https://notes.example.com" };
    expect(publicUrl("/login", internal, env).toString()).toBe("https://notes.example.com/login");
    expect(ownOrigin(internal, env)).toBe("https://notes.example.com");
  });

  it("keeps the request origin on self-hosted deployments and when APP_URL is unusable", () => {
    expect(ownOrigin(internal, {})).toBe("https://0.0.0.0:8080");
    expect(ownOrigin(internal, { MANAGED_HOSTING: "true" })).toBe("https://0.0.0.0:8080");
  });
});
