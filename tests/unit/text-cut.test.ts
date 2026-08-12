import { describe, it, expect } from "vitest";
import { safeCutEnd, dropLastCodePoint, safeByteCutEnd, clampMarked, safeTailStart, safeByteTailStart } from "../../src/text-cut.js";

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

// Surrogate-aware delete-last coverage (Issue #824): the composer backspace must
// drop the whole final code point, never orphan half of a surrogate pair.
describe("dropLastCodePoint (Issue #824)", () => {
  it("removes a trailing emoji/astral character whole, leaving no unpaired surrogate", () => {
    const out = dropLastCodePoint("deploy the 🚀");
    expect(out).toBe("deploy the ");
    expect(out).not.toMatch(/[\ud800-\udfff]/);
  });

  it("regression: removes exactly one ASCII/BMP character", () => {
    expect(dropLastCodePoint("hello")).toBe("hell");
    expect(dropLastCodePoint("a")).toBe("");
  });

  it("returns empty text unchanged (no-op)", () => {
    expect(dropLastCodePoint("")).toBe("");
  });

  it("removes a trailing astral char even among astral chars", () => {
    expect(dropLastCodePoint("🚀🚀")).toBe("🚀");
    expect(dropLastCodePoint("🚀")).toBe("");
  });
});

// Byte-budgeted, surrogate-safe cut coverage (Issue #834): the subprocess output
// caps budget UTF-8 bytes, but String.length counts UTF-16 code units. The cut
// must honor the byte budget for multi-byte text and still never orphan a
// surrogate pair.
describe("safeByteCutEnd (Issue #834)", () => {
  it("returns the full length when the text fits the byte budget", () => {
    expect(safeByteCutEnd("abc", 10)).toBe(3);
    expect(safeByteCutEnd("abc", 3)).toBe(3);
    expect(safeByteCutEnd("", 5)).toBe(0);
  });

  it("returns 0 for a non-positive budget", () => {
    expect(safeByteCutEnd("abc", 0)).toBe(0);
    expect(safeByteCutEnd("abc", -1)).toBe(0);
  });

  it("bounds the cut by real UTF-8 bytes for multi-byte BMP text", () => {
    // 你 = 3 bytes; 你好 = 6 bytes.
    expect(safeByteCutEnd("你好", 3)).toBe(1); // only 你 fits
    expect(safeByteCutEnd("你好", 5)).toBe(1); // 你好 is 6 bytes > 5
    expect(safeByteCutEnd("你好", 6)).toBe(2); // both fit exactly
  });

  it("drops an astral char whole rather than splitting it at the byte bound", () => {
    // 🚀 = 4 bytes (2 code units). "a🚀" = 5 bytes.
    expect(safeByteCutEnd("a🚀", 4)).toBe(1); // 🚀 (4B) won't fit after "a" (1B): keep "a"
    expect(safeByteCutEnd("a🚀", 5)).toBe(3); // whole "a🚀" fits
    expect(safeByteCutEnd("🚀", 3)).toBe(0); // 4-byte emoji does not fit in 3 bytes
    expect(safeByteCutEnd("🚀", 4)).toBe(2); // fits exactly
  });

  it("never exceeds the byte budget nor leaves an unpaired surrogate across cuts", () => {
    const s = "ab你好🚀🚀cd";
    for (let bytes = 0; bytes <= Buffer.byteLength(s, "utf8") + 2; bytes++) {
      const cut = safeByteCutEnd(s, bytes);
      const out = s.slice(0, cut);
      expect(Buffer.byteLength(out, "utf8"), `bytes=${bytes}`).toBeLessThanOrEqual(bytes);
      expect(out, `bytes=${bytes}`).not.toMatch(/[\ud800-\udbff]$/);
    }
  });
});

describe("clampMarked (Issue #842)", () => {
  const UNPAIRED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("returns text unchanged when it fits the cap", () => {
    expect(clampMarked("hello", 10, "…")).toBe("hello");
    expect(clampMarked("hello", 5, "…")).toBe("hello");
    expect(clampMarked("", 5, "…")).toBe("");
  });

  it("truncates ASCII text and appends the marker", () => {
    expect(clampMarked("abcdef", 3, "…")).toBe("abc…");
  });

  it("drops an astral character whole when it straddles the cap", () => {
    const out = clampMarked("a".repeat(9) + "🚀", 10, "…");
    expect(out).toBe("a".repeat(9) + "…");
    expect(out).not.toMatch(UNPAIRED);
  });

  it("never leaves an unpaired surrogate for any cap across mixed text", () => {
    const s = "ab你好🚀🚀cd";
    for (let max = 0; max <= s.length + 2; max++) {
      expect(clampMarked(s, max, "…"), `max=${max}`).not.toMatch(UNPAIRED);
    }
  });
});

describe("safeTailStart (Issue #860)", () => {
  const UNPAIRED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("returns 0 when the whole text fits the budget", () => {
    expect(safeTailStart("hello", 10)).toBe(0);
    expect(safeTailStart("hello", 5)).toBe(0);
    expect(safeTailStart("", 5)).toBe(0);
  });

  it("returns text.length for an empty budget or empty text", () => {
    expect(safeTailStart("abc", 0)).toBe(3);
    expect(safeTailStart("abc", -1)).toBe(3);
    expect(safeTailStart("", 0)).toBe(0);
  });

  it("keeps the trailing maxChars code units for ASCII", () => {
    expect("abcdef".slice(safeTailStart("abcdef", 3))).toBe("def");
  });

  it("drops an orphaned low surrogate when the cut lands inside a pair", () => {
    const s = "aaaa😀bbbb"; // 😀 occupies code units 4 (high) and 5 (low)
    expect(safeTailStart(s, 5)).toBe(6); // naive cut 10-5=5 lands on the low surrogate
    expect(s.slice(safeTailStart(s, 5))).toBe("bbbb");
  });

  it("keeps a pair whole when the cut lands on its high surrogate", () => {
    const s = "aaaa😀bbbb";
    expect(s.slice(safeTailStart(s, 6))).toBe("😀bbbb");
  });

  it("never leaves an unpaired surrogate for any tail budget across mixed text", () => {
    const s = "ab你好😀😀cd";
    for (let max = 0; max <= s.length + 2; max++) {
      expect(s.slice(safeTailStart(s, max)), `max=${max}`).not.toMatch(UNPAIRED);
    }
  });
});

describe("safeByteTailStart (Issue #860)", () => {
  const UNPAIRED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("returns 0 when the whole text fits the byte budget", () => {
    expect(safeByteTailStart("abc", 10)).toBe(0);
    expect(safeByteTailStart("abc", 3)).toBe(0);
    expect(safeByteTailStart("", 5)).toBe(0);
  });

  it("returns text.length for an empty budget or empty text", () => {
    expect(safeByteTailStart("abc", 0)).toBe(3);
    expect(safeByteTailStart("abc", -1)).toBe(3);
    expect(safeByteTailStart("", 0)).toBe(0);
  });

  it("bounds the kept tail by real UTF-8 bytes for multi-byte BMP text", () => {
    const s = "你好"; // 6 bytes (3 each)
    expect(s.slice(safeByteTailStart(s, 3))).toBe("好"); // only the last 3-byte char fits
    expect(s.slice(safeByteTailStart(s, 6))).toBe("你好");
  });

  it("drops an astral char whole rather than splitting it at the byte bound", () => {
    const s = "a🚀"; // 1 + 4 = 5 bytes
    expect(s.slice(safeByteTailStart(s, 4))).toBe("🚀");
    expect(s.slice(safeByteTailStart(s, 5))).toBe("a🚀");
    expect("🚀".slice(safeByteTailStart("🚀", 3))).toBe(""); // 4-byte emoji does not fit in 3 bytes
  });

  it("never exceeds the byte budget nor leaves an unpaired surrogate across cuts", () => {
    const s = "ab你好🚀🚀cd";
    for (let bytes = 0; bytes <= Buffer.byteLength(s, "utf8") + 2; bytes++) {
      const out = s.slice(safeByteTailStart(s, bytes));
      expect(Buffer.byteLength(out, "utf8"), `bytes=${bytes}`).toBeLessThanOrEqual(bytes);
      expect(out, `bytes=${bytes}`).not.toMatch(UNPAIRED);
    }
  });
});
