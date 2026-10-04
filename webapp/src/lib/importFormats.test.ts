import { describe, expect, it } from "vitest";
import {
  IMPORT_EXTENSIONS,
  formatImportBytes,
  formatImportDuration,
  importAcceptAttribute,
  importFormatFromName,
} from "./importFormats";

describe("import format helpers", () => {
  it("accepts each supported file extension case-insensitively", () => {
    for (const extension of IMPORT_EXTENSIONS) {
      expect(importFormatFromName(`meeting.${extension.toUpperCase()}`)).toBe(extension);
    }
    expect(importAcceptAttribute()).toBe(`${IMPORT_EXTENSIONS.map((extension) => `.${extension}`).join(",")},audio/*,video/*`);
  });

  it("rejects missing, trailing, or unsupported file extensions", () => {
    for (const name of ["meeting", "meeting.", "meeting.exe", "meeting.mp3?download=1", "   "]) {
      expect(importFormatFromName(name)).toBeNull();
    }
    expect(importFormatFromName("  recording.M4A  ")).toBe("m4a");
  });

  it("formats duration across minute and hour rounding boundaries", () => {
    expect(formatImportDuration(-1)).toBe("under a minute");
    expect(formatImportDuration(59)).toBe("under a minute");
    expect(formatImportDuration(60)).toBe("1 min");
    expect(formatImportDuration(3_599)).toBe("1 h");
    expect(formatImportDuration(3_660)).toBe("1 h 1 min");
    expect(formatImportDuration(Number.NaN)).toBe("under a minute");
  });

  it("formats empty, byte, decimal kilobyte, megabyte, and gigabyte sizes", () => {
    expect(formatImportBytes(0)).toBe("0 B");
    expect(formatImportBytes(999)).toBe("999 B");
    expect(formatImportBytes(1_000)).toBe("1 KB");
    expect(formatImportBytes(1_000_000)).toBe("1 MB");
    expect(formatImportBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatImportBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
