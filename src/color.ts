// Centralized ANSI color (SGR) control. Color is suppressed by an explicit
// `--no-color` flag or by a non-empty `NO_COLOR` environment variable, per the
// widely-adopted https://no-color.org convention. Absent both, color stays on
// so existing interactive behavior is unchanged.

export interface ColorPalette {
  bold: string;
  dim: string;
  reset: string;
}

// Whether ANSI color escapes should be emitted. `noColor` (the `--no-color`
// flag) wins outright; otherwise a present, non-empty `NO_COLOR` suppresses
// color regardless of its value (even "0"), while an empty string does not.
export function colorEnabled(
  opts: { noColor?: boolean; env?: Record<string, string | undefined> } = {},
): boolean {
  if (opts.noColor) return false;
  const env = opts.env ?? process.env;
  const value = env.NO_COLOR;
  return value === undefined || value === "";
}

// Styling helpers that degrade to empty strings when color is disabled, so
// callers can build output unconditionally.
export function createColorPalette(enabled: boolean): ColorPalette {
  if (!enabled) return { bold: "", dim: "", reset: "" };
  const esc = "\x1b[";
  return { bold: `${esc}1m`, dim: `${esc}2m`, reset: `${esc}0m` };
}
