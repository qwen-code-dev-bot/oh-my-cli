// Paste-to-composer transform for the full-screen shell (Issue #733).
// Multi-character text arriving at the input fallback is paste (typed keys
// reach the single-byte branch individually, and typed Enter never appears
// inside a multi-byte chunk). Before this transform, the fallback dropped
// every line terminator, so pasted lines ran together word-to-word
// ("first line\nsecond line" → "first linesecond line") and submitted
// corrupted. Line boundaries now map to the composer's native multi-line
// model instead.

// Convert a pasted chunk to composer text: line boundaries (LF, CR, or CRLF
// as one) become "\n"; other control bytes are dropped; leading and trailing
// boundaries (paste artifacts) are stripped while internal boundaries —
// including intentional blank lines — are preserved. Returns "" when the
// chunk carries no insertable content.
export function pastedTextToComposer(s: string): string {
  let out = "";
  const chars = [...s];
  for (let k = 0; k < chars.length; k++) {
    const cp = chars[k].codePointAt(0)!;
    if (cp === 0x0d) {
      // CRLF counts as a single boundary.
      if (k + 1 < chars.length && chars[k + 1].codePointAt(0) === 0x0a) k++;
      out += "\n";
      continue;
    }
    if (cp === 0x0a) {
      out += "\n";
      continue;
    }
    if (cp === 0x7f || cp < 0x20) continue;
    out += chars[k];
  }
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === "\n") start++;
  while (end > start && out[end - 1] === "\n") end--;
  return out.slice(start, end);
}
