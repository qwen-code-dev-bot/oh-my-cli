import { describe, it, expect } from "vitest";
import { formatAttention, type AttentionItem } from "../../src/attention-summary.js";
import { asciiSafeLine } from "../../src/ascii-output.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    type: "turn-completed",
    sessionId: "session-a",
    lastModified: 1,
    ageMs: 0,
    status: "final answer delivered",
    actions: ["continue with --resume a"],
    ...overrides,
  };
}

const WS = "/srv/ws";

describe("formatAttention lines refactor (Issue #698)", () => {
  it("returns lines whose join matches the pre-refactor text shape", () => {
    const lines = formatAttention([item()], WS);
    expect(Array.isArray(lines)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain("Attention — workspace");
    expect(joined).toContain("─".repeat(40));
    expect(joined).toContain("✓ turn-completed");
    expect(joined).toContain("→ continue with --resume a");
    expect(joined).toContain("·");
    expect(joined).toMatch(/1 item\(s\)\. Read-only: nothing here executes or approves anything\./);
    expect(joined.endsWith("\n")).toBe(false);
  });

  it("returns the empty-state branch as lines too", () => {
    const lines = formatAttention([], WS);
    expect(lines.join("\n")).toContain("Nothing needs attention in this workspace.");
  });

  it("renders the cancelled mark for turn-cancelled items", () => {
    const joined = formatAttention([item({ type: "turn-cancelled", actions: [] })], WS).join("\n");
    expect(joined).toContain("⊘ turn-cancelled");
  });
});

describe("attention glyphs under the ASCII map (Issue #698)", () => {
  it("maps every attention glyph in rendered lines", () => {
    const joined = formatAttention(
      [item(), item({ type: "turn-cancelled", sessionId: "b", actions: [] })],
      WS,
    ).join("\n");
    const mapped = joined.split("\n").map(asciiSafeLine).join("\n");
    expect(mapped).toContain("[ok] turn-completed");
    expect(mapped).toContain("[off] turn-cancelled");
    expect(mapped).toContain("-> continue with --resume a");
    expect(mapped).toContain("Attention - workspace");
    expect(mapped).toContain("-".repeat(40));
    expect(/[✓⊘→─·]/.test(mapped)).toBe(false);
  });

  it("leaves the plain ! mark and plain text untouched", () => {
    const mapped = asciiSafeLine("  ! turn-failed  ab  ·  last active 5m ago");
    expect(mapped).toBe("  ! turn-failed  ab  |  last active 5m ago");
  });
});
