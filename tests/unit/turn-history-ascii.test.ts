import { describe, it, expect } from "vitest";
import { asciiSafeLine } from "../../src/ascii-output.js";

describe("turn-history glyphs under the ASCII map (Issue #700)", () => {
  it("maps the separator line plain", () => {
    expect(asciiSafeLine("─".repeat(40))).toBe("-".repeat(40));
  });

  it("maps a rendered turn line (dots and the message-count arrow)", () => {
    const line = "  0. 2026-01-01T00:00:00Z · captured +2 msgs → 3 msgs · 0 files";
    expect(asciiSafeLine(line)).toBe(
      "  0. 2026-01-01T00:00:00Z | captured +2 msgs -> 3 msgs | 0 files",
    );
  });

  it("maps the header em dash", () => {
    expect(asciiSafeLine("Turn history — session ab12cd34")).toBe(
      "Turn history - session ab12cd34",
    );
  });

  it("leaves plain text untouched", () => {
    expect(asciiSafeLine("No turn checkpoints recorded for this session.")).toBe(
      "No turn checkpoints recorded for this session.",
    );
  });
});
