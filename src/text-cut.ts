// Surrogate-safe text cutting (Issue #812).
//
// String.prototype.slice indexes UTF-16 code units, so a cut that lands inside a
// surrogate pair (an emoji or other astral character occupies two code units)
// orphans one half and emits a broken character at the truncation boundary.
// safeCutEnd adjusts a cut index so a surrogate pair is dropped whole rather
// than split. It is a pure, dependency-free helper used by the CLI's text
// truncation sites.

/**
 * Return the largest cut index `<= end` that does not split a UTF-16 surrogate
 * pair in `text`. When the code unit immediately before the cut is a high
 * surrogate, its low-surrogate partner sits at `end` and would be orphaned, so
 * the cut is moved back one to exclude the pair. ASCII and in-range cuts are
 * returned unchanged; an out-of-range `end` is clamped to the text bounds.
 */
export function safeCutEnd(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  const prev = text.charCodeAt(end - 1);
  // High surrogate (U+D800–U+DBFF) right before the cut: its partner is at
  // `end`, so including it alone would leave an unpaired surrogate.
  if (prev >= 0xd800 && prev <= 0xdbff) return end - 1;
  return end;
}

/**
 * Remove the last code point from `text`, surrogate-aware (Issue #824). Unlike
 * `text.slice(0, -1)` — which drops one UTF-16 code unit and orphans half of an
 * emoji/astral surrogate pair — this drops the entire final code point. Returns
 * `text` unchanged when it is empty.
 */
export function dropLastCodePoint(text: string): string {
  if (text === "") return text;
  return Array.from(text).slice(0, -1).join("");
}
