import { describe, expect, it } from "vitest";
import { FORM_ERROR_ID, formFields, invalidRoles } from "./fieldErrors";

describe("login field errors", () => {
  it("knows which fields each error is about", () => {
    expect(invalidRoles("invalid")).toEqual(["email", "password"]);
    expect(invalidRoles("consent-required")).toEqual(["consent"]);
    expect(invalidRoles("throttled")).toEqual([]);
    expect(invalidRoles(undefined)).toEqual([]);
    expect(invalidRoles("__proto__")).toEqual([]);
  });

  it("marks invalid fields, keeps hints, and focuses the first problem", () => {
    const field = formFields("password-mismatch", ["workspace", "email", "password", "confirm", "consent"]);
    expect(field("workspace", { autoFocus: true })).toEqual({});
    expect(field("email")).toEqual({});
    expect(field("password", { hint: "pw-hint" })).toEqual({ "aria-invalid": true, "aria-describedby": `${FORM_ERROR_ID} pw-hint`, autoFocus: true });
    expect(field("confirm")).toEqual({ "aria-invalid": true, "aria-describedby": FORM_ERROR_ID });
  });

  it("keeps the default focus and hint when nothing is wrong", () => {
    const field = formFields(undefined, ["workspace", "password"]);
    expect(field("workspace", { autoFocus: true })).toEqual({ autoFocus: true });
    expect(field("password", { hint: "pw-hint" })).toEqual({ "aria-describedby": "pw-hint" });
  });

  it("ignores errors about fields a form doesn't have", () => {
    const field = formFields("workspace-name", ["email", "password"]);
    expect(field("email", { autoFocus: true })).toEqual({ autoFocus: true });
  });
});
