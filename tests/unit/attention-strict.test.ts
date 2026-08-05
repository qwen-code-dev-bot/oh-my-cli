import { describe, it, expect } from "vitest";
import { attentionStrictExit, type AttentionItem } from "../../src/attention-summary.js";

function item(type: AttentionItem["type"], sessionId: string): AttentionItem {
  return {
    type,
    sessionId,
    lastModified: 1,
    ageMs: 0,
    status: "durable status line",
    actions: ["inspect with --session-stats x"],
  };
}

describe("attentionStrictExit (Issue #682)", () => {
  it("maps an empty summary to exit 0", () => {
    expect(attentionStrictExit([])).toBe(0);
  });

  it("maps a single item to exit 1", () => {
    expect(attentionStrictExit([item("turn-completed", "a")])).toBe(1);
  });

  it("maps many items to exit 1", () => {
    expect(
      attentionStrictExit([
        item("corrupt-session", "a"),
        item("turn-failed", "b"),
        item("partial-session", "c"),
      ]),
    ).toBe(1);
  });

  it("is a pure, stable mapping", () => {
    const failing = [item("turn-cancelled", "a")];
    expect(attentionStrictExit(failing)).toBe(attentionStrictExit(failing));
    const quiet: AttentionItem[] = [];
    expect(attentionStrictExit(quiet)).toBe(attentionStrictExit(quiet));
  });
});
