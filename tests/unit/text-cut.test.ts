import { describe, it, expect } from "vitest";
import { safeCutEnd } from "../../src/text-cut.js";

// Pure-function coverage for the surrogate-safe cut helper (Issue #812):
// ASCII/in-range cuts pass through, out-of-range ends clamp to the bounds, and
// a cut that would orphan the high half of a surrogate pair backs off so the
// pair is dropped whole rather than split.

describe("safeCutEnd", () => {
  it("returns ASCII/in-range cuts unchanged", () => {
    expect(safeCutEnd("hello", 3)).toBe(3);
    expect(safeCutEnd("hello", 5)).toBe(5);
    expect(safeCutEnd("", 0)).toBe(0);
  });

  it("clamps out-of-range ends to the text bounds", () => {
    expect(safeCutEnd("hi", 10)).toBe(2);
    expect(safeCutEnd("hi", -3)).toBe(0);
    expect(safeCutEnd("", 5)).toBe(0);
  });

  it("backs off a cut that would orphan a high surrogate", () => {
    const s = "ab😀cdef"; // 😀 occupies UTF-16 code units 2 and 3
    expect(safeCutEnd(s, 3)).toBe(2);
    expect(s.slice(0, safeCutEnd(s, 3))).toBe("ab");
  });

  it("keeps a cut that ends exactly after a complete surrogate pair", () => {
    const s = "ab😀cdef";
    expect(safeCutEnd(s, 4)).toBe(4);
    expect(s.slice(0, safeCutEnd(s, 4))).toBe("ab😀");
  });

  it("never leaves a trailing unpaired surrogate for any cut of emoji text", () => {
    const s = "x😀y😀😀z";
    for (let n = 0; n <= s.length + 2; n++) {
      const out = s.slice(0, safeCutEnd(s, n));
      expect(out, `cut=${n}`).not.toMatch(/[\ud800-\udbff]$/);
    }
  });
});
