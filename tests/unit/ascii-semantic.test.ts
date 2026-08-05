import { describe, it, expect } from "vitest";
import { asciiSafe, asciiSafeLine, renderReportLines } from "../../src/ascii-output.js";

describe("semantic glyph mappings (Issue #674)", () => {
  it("maps each semantic mark to readable ASCII preserving its meaning", () => {
    expect(asciiSafeLine("…")).toBe("...");
    expect(asciiSafeLine("→")).toBe("->");
    expect(asciiSafeLine("↔")).toBe("<->");
    expect(asciiSafeLine("✓")).toBe("[ok]");
    expect(asciiSafeLine("✗")).toBe("[bad]");
    expect(asciiSafeLine("name ✓ goal ✗")).toBe("name [ok] goal [bad]");
    expect(asciiSafeLine("diverged ↔ shared")).toBe("diverged <-> shared");
    expect(asciiSafeLine("truncated…")).toBe("truncated...");
    expect(asciiSafeLine("a → b → c")).toBe("a -> b -> c");
  });

  it("still maps the #672 decorative glyphs exactly as before", () => {
    expect(asciiSafeLine("─")).toBe("-");
    expect(asciiSafeLine("·")).toBe("|");
    expect(asciiSafeLine("×")).toBe("x");
    expect(asciiSafeLine("—")).toBe("-");
    expect(asciiSafeLine("  2026-01-01T00:00:00.000Z · note · detail")).toBe(
      "  2026-01-01T00:00:00.000Z | note | detail",
    );
  });

  it("leaves plain ASCII and unrelated unicode untouched", () => {
    expect(asciiSafeLine("plain ascii 123 [ok]")).toBe("plain ascii 123 [ok]");
    expect(asciiSafeLine("café ☃")).toBe("café ☃");
  });

  it("is idempotent over the extended map", () => {
    const lines = ["✓ done", "✗ failed", "a → b ↔ c", "wait…", "─ · × —"];
    const once = asciiSafe(lines);
    expect(asciiSafe(once)).toEqual(once);
  });

  it("renderReportLines applies the extended map only when ascii is set", () => {
    const lines = ["✓ ok", "─".repeat(4)];
    expect(renderReportLines(lines, undefined)).toBe(lines.join("\n") + "\n");
    expect(renderReportLines(lines, true)).toBe(asciiSafe(lines).join("\n") + "\n");
  });
});
