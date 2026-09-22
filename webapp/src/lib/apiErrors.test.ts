import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "./meetings";
import { apiErrorResponse, jsonError, requestIdFrom } from "./apiErrors";

afterEach(() => vi.restoreAllMocks());

describe("API error responses", () => {
  it("returns an actionable 400 without leaking a correlation id into the body", async () => {
    const response = apiErrorResponse(new ValidationError("bad input"), { requestId: "request-1" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad input" });
    expect(response.headers.get("x-request-id")).toBe("request-1");
  });

  it("logs unexpected errors and returns a generic 500 with a correlation id", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiErrorResponse(new Error("database password"));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: "internal server error" });
    expect(body.requestId).toEqual(expect.any(String));
    expect(logger).toHaveBeenCalledWith("api request failed", expect.objectContaining({ error: "database password" }));
  });

  it("preserves a valid incoming request id and replaces oversized ids", () => {
    expect(requestIdFrom(new Request("http://localhost", { headers: { "x-request-id": "client-request" } }))).toBe("client-request");
    expect(requestIdFrom(new Request("http://localhost", { headers: { "x-request-id": "x".repeat(129) } }))).toEqual(expect.any(String));
  });

  it("creates consistent JSON errors for body and size limits", async () => {
    const response = jsonError("too large", 413, "request-2");
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too large", requestId: "request-2" });
  });
});
