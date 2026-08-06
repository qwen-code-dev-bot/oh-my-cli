// ASCII-safe output mode for the read-only report/journal surfaces
// (Issue #672), extended to the read-only session surfaces (Issue #674).
//
// The report/journal family renders with Unicode decoration — box-drawing
// separators, middle dots, multiplication signs, em dashes — and the
// session surfaces additionally emit semantic marks (status checks, arrows,
// ellipses); the health inventory adds warning/disabled status marks
// (Issue #696). For screen readers, legacy terminals, C-locale pipelines, and
// log scrapers these glyphs are noise or breakage. `--ascii` maps the
// glyphs to ASCII equivalents while keeping all content and structure
// identical: decorative glyphs map to their nearest ASCII shape; semantic
// marks map to readable ASCII that preserves the mark's meaning.
//
// The transformation is a pure, deterministic per-line substitution applied
// only to the known glyphs; user content (note text, goal objectives) is
// never rewritten. JSON output is untouched — it is already ASCII-safe data.

/**
 * Glyphs emitted by the in-scope surfaces, mapped to ASCII. Semantic marks
 * (Issue #674) map to readable ASCII preserving the mark's meaning;
 * decorative glyphs map to their nearest ASCII shape.
 */
export const ASCII_GLYPH_MAP: Readonly<Record<string, string>> = {
  "\u2500": "-", // ─ box-drawing separator
  "\u00b7": "|", // · middle-dot field separator
  "\u00d7": "x", // × count multiplier
  "\u2014": "-", // — em dash
  "\u2026": "...", // … ellipsis
  "\u2192": "->", // → arrow
  "\u2194": "<->", // ↔ bidirectional arrow
  "\u2713": "[ok]", // ✓ positive status mark
  "\u2717": "[bad]", // ✗ negative status mark
  "\u26a0": "[warn]", // ⚠ warning status mark (Issue #696)
  "\u2298": "[off]", // ⊘ disabled status mark (Issue #696)
};

const ASCII_GLYPH_RE = /[\u2500\u00b7\u00d7\u2014\u2026\u2192\u2194\u2713\u2717\u26a0\u2298]/g;

/** Map the known glyphs of one line to ASCII equivalents. Pure. */
export function asciiSafeLine(line: string): string {
  return line.replace(ASCII_GLYPH_RE, (ch) => ASCII_GLYPH_MAP[ch]);
}

/** Map the known glyphs of rendered lines to ASCII equivalents. Pure. */
export function asciiSafe(lines: string[]): string[] {
  return lines.map(asciiSafeLine);
}

/**
 * Join rendered report/journal lines for stdout, applying the ASCII glyph
 * map when `ascii` is true (Issue #672). Without it the lines pass through
 * untouched, byte-identical to the pre-flag behavior.
 */
export function renderReportLines(lines: string[], ascii: boolean | undefined): string {
  return (ascii === true ? asciiSafe(lines) : lines).join("\n") + "\n";
}
