// ASCII-safe output mode for the read-only report/journal surfaces
// (Issue #672).
//
// The report/journal family renders with Unicode decoration — box-drawing
// separators, middle dots, multiplication signs, em dashes. For screen
// readers, legacy terminals, C-locale pipelines, and log scrapers these
// glyphs are noise or breakage. `--ascii` maps the decorative glyphs to
// ASCII equivalents while keeping all content and structure identical.
//
// The transformation is a pure, deterministic per-line substitution applied
// only to the known decorative glyphs; user content (note text, goal
// objectives) is never rewritten. JSON output is untouched — it is already
// ASCII-safe data.

/** Decorative glyphs emitted by the in-scope surfaces, mapped to ASCII. */
export const ASCII_GLYPH_MAP: Readonly<Record<string, string>> = {
  "\u2500": "-", // ─ box-drawing separator
  "\u00b7": "|", // · middle-dot field separator
  "\u00d7": "x", // × count multiplier
  "\u2014": "-", // — em dash
};

const ASCII_GLYPH_RE = /[\u2500\u00b7\u00d7\u2014]/g;

/** Map the decorative glyphs of one line to ASCII equivalents. Pure. */
export function asciiSafeLine(line: string): string {
  return line.replace(ASCII_GLYPH_RE, (ch) => ASCII_GLYPH_MAP[ch]);
}

/** Map the decorative glyphs of rendered lines to ASCII equivalents. Pure. */
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
