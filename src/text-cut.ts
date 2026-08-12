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

/**
 * Return the largest cut index whose UTF-8 byte length is `<= maxBytes` and that
 * does not split a UTF-16 surrogate pair (Issue #834). The subprocess output caps
 * budget bytes, but `String.length` counts UTF-16 code units, which under-counts
 * bytes for non-ASCII text; this helper finds a cut that honors the byte budget
 * while staying surrogate-safe. Binary-searches the byte length (monotonic in the
 * cut index), then defers to `safeCutEnd` so the final boundary never orphans a
 * surrogate. Returns `0` for an empty budget or empty text, and `text.length`
 * unchanged when the whole string already fits.
 */
export function safeByteCutEnd(text: string, maxBytes: number): number {
  if (maxBytes <= 0 || text === "") return 0;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text.length;
  let lo = 0;
  // Each code unit is at least one UTF-8 byte, so the answer is <= maxBytes.
  let hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return safeCutEnd(text, lo);
}

/**
 * Truncate `text` to at most `maxChars` UTF-16 code units, appending `marker`
 * when truncated (Issue #842). The cut is made via `safeCutEnd`, so an astral
 * character straddling the cap is dropped whole rather than orphaned as an
 * unpaired surrogate immediately before the marker. Returns `text` unchanged
 * when it already fits.
 */
export function clampMarked(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, safeCutEnd(text, maxChars)) + marker;
}

/**
 * Return the start index for keeping the trailing `maxChars` UTF-16 code units
 * of `text` without splitting a surrogate pair (Issue #860). This is the
 * tail-keeping complement of `safeCutEnd`: callers render `text.slice(result)`.
 * If the naive cut `text.length - maxChars` lands on a low surrogate — whose
 * high-surrogate partner sits just before the cut and would be dropped — the
 * start is advanced one to discard the orphaned low surrogate, so the kept tail
 * never begins with an unpaired surrogate. Returns `0` when the whole string
 * already fits, and `text.length` (empty tail) for an empty budget/text.
 */
export function safeTailStart(text: string, maxChars: number): number {
  if (maxChars <= 0 || text === "") return text.length;
  if (text.length <= maxChars) return 0;
  const start = text.length - Math.floor(maxChars);
  const unit = text.charCodeAt(start);
  // Low surrogate (U+DC00–U+DFFF): its partner is at `start - 1` and is being
  // cut away, so keeping it would orphan it. Drop it.
  if (unit >= 0xdc00 && unit <= 0xdfff) return start + 1;
  return start;
}

/**
 * Return the start index for keeping the trailing portion of `text` whose UTF-8
 * byte length is `<= maxBytes`, without splitting a surrogate pair (Issue #860).
 * The tail-keeping complement of `safeByteCutEnd`: callers render
 * `text.slice(result)`. The tail's byte length is monotonic (non-increasing) in
 * the start index, so this binary-searches the smallest start that honors the
 * byte budget, then discards a leading orphaned low surrogate if the cut lands
 * on one. Returns `0` when the whole string already fits, and `text.length`
 * (empty tail) for an empty budget/text.
 */
export function safeByteTailStart(text: string, maxBytes: number): number {
  if (maxBytes <= 0 || text === "") return text.length;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return 0;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(text.slice(mid), "utf8") <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  const unit = lo < text.length ? text.charCodeAt(lo) : 0;
  if (unit >= 0xdc00 && unit <= 0xdfff) return lo + 1;
  return lo;
}
