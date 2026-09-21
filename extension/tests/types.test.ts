import { describe, expect, it } from "vitest";
import { speakerLabel } from "../src/types";

describe("speakerLabel", () => {
  it("labels the local mic channel as You", () => {
    expect(speakerLabel("you")).toBe("You");
  });

  it("labels the first remote speaker as plain Them", () => {
    expect(speakerLabel("them")).toBe("Them");
  });

  it("distinguishes additional remote speakers instead of flattening them all to Them", () => {
    expect(speakerLabel("them-2")).toBe("Them 2");
    expect(speakerLabel("them-3")).toBe("Them 3");
  });
});
