// Responsive pixel-art product banner for the interactive REPL.
//
// Renders an original "OH MY CLI" wordmark (wide), a compact "OMC" mark
// (medium), or a pure-ASCII fallback (plain) chosen from the terminal width and
// color capability. The banner is printed once at startup and never redrawn, so
// it yields space naturally as the conversation scrolls — no redraw corruption.
// Display metadata is redacted (workspace collapsed to ~, no credentials) so it
// never leaks a full path or a secret. The art uses ordinary box-drawing glyphs
// and spaces: no bidirectional, zero-width, or look-alike characters.

import { redactHomePath } from "./permission-impact.js";

export const VERSION = "0.1.0";

export type ColorDepth = "truecolor" | "256" | "basic" | "none";
export type BannerVariant = "wide" | "medium" | "plain";

export interface BannerModel {
  version: string;
  model: string;
  workspace: string;
  authReady: boolean;
  approvalMode: string;
}

// Minimum terminal widths for each art variant. Below MEDIUM_MIN we fall back to
// the pure-ASCII plain variant so nothing clips or wraps. The wide wordmark is
// 41 columns and the medium mark is 13, so each threshold leaves a margin.
const WIDE_MIN = 44;
const MEDIUM_MIN = 20;

// Original 5-row outlined wordmark "OH MY CLI" (41 columns).
export const WIDE_WORDMARK: readonly string[] = [
  "╭───╮ ╷   ╷ ╷   ╷ ╷   ╷ ╭───╮ ╷     ╭───╮",
  "│   │ │   │ │╲ ╱│ ╰╮ ╭╯ │     │       │  ",
  "│   │ ├───┤ │ ╳ │  ╰─╯  │     │       │  ",
  "│   │ │   │ │   │   │   │     │       │  ",
  "╰───╯ ╵   ╵ ╵   ╵   ╵   ╰───╯ ╰───╯ ╰───╯",
];

// Compact 3-row "OMC" mark (13 columns) for medium widths.
export const MEDIUM_MARK: readonly string[] = [
  "███ █   █ ███",
  "█ █ ██ ██ █  ",
  "███ █ █ █ ███",
];

const PLAIN_TEXT = "OH MY CLI";

// Brand palette: dark blue → violet → rose, applied as a left-to-right gradient.
// Each stop carries a truecolor RGB triple, a 256-color index, and a 16-color
// (basic) SGR base so the same art degrades across color capabilities.
interface PaletteStop {
  rgb: readonly [number, number, number];
  c256: number;
  basic: number;
}
const GRADIENT: readonly PaletteStop[] = [
  { rgb: [80, 120, 220], c256: 63, basic: 34 }, // blue
  { rgb: [150, 100, 220], c256: 134, basic: 35 }, // violet
  { rgb: [220, 110, 160], c256: 168, basic: 31 }, // rose
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// Resolve the effective color depth. The `--no-color` flag or a non-empty
// `NO_COLOR` (per no-color.org) yields "none"; otherwise the terminal's
// advertised capability (COLORTERM / TERM) selects the richest encoding.
export function detectColorDepth(
  opts: { noColor?: boolean; env?: Record<string, string | undefined>; isTTY?: boolean } = {},
): ColorDepth {
  if (opts.noColor) return "none";
  const env = opts.env ?? {};
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return "none";
  if (opts.isTTY === false) return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("256color")) return "256";
  return "basic";
}

// Choose the art variant from width and depth. Reduced color (none) or a narrow
// terminal selects the pure-ASCII plain variant; otherwise width picks wide vs.
// medium.
export function selectBannerVariant(width: number, depth: ColorDepth): BannerVariant {
  if (depth === "none") return "plain";
  if (width < MEDIUM_MIN) return "plain";
  if (width < WIDE_MIN) return "medium";
  return "wide";
}

// Build the display model, redacting the workspace path. No credential (api key,
// base URL) is ever carried into the model.
export function buildProductBanner(input: {
  version: string;
  model: string;
  workspace: string;
  authReady: boolean;
  approvalMode: string;
}): BannerModel {
  return {
    version: input.version,
    model: input.model,
    workspace: redactHomePath(input.workspace),
    authReady: input.authReady,
    approvalMode: input.approvalMode,
  };
}

function fg(stop: PaletteStop, depth: ColorDepth): string {
  if (depth === "truecolor") {
    return `\x1b[38;2;${stop.rgb[0]};${stop.rgb[1]};${stop.rgb[2]}m`;
  }
  if (depth === "256") return `\x1b[38;5;${stop.c256}m`;
  if (depth === "basic") return `\x1b[1;${stop.basic}m`;
  return "";
}

function colorIndexFor(col: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(GRADIENT.length - 1, Math.floor((col * GRADIENT.length) / width));
}

// Apply the gradient to a single art row, coloring only non-space cells and
// grouping consecutive same-color cells into one SGR run. With depth "none" the
// row is returned untouched (no escapes).
function colorizeRow(row: string, depth: ColorDepth): string {
  if (depth === "none") return row;
  const cells = Array.from(row);
  const width = cells.length;
  let out = "";
  let i = 0;
  while (i < width) {
    if (cells[i] === " ") {
      let j = i;
      while (j < width && cells[j] === " ") j++;
      out += cells.slice(i, j).join("");
      i = j;
      continue;
    }
    const ci = colorIndexFor(i, width);
    let j = i;
    while (j < width && cells[j] !== " " && colorIndexFor(j, width) === ci) j++;
    out += fg(GRADIENT[ci], depth) + cells.slice(i, j).join("") + RESET;
    i = j;
  }
  return out;
}

function artRows(variant: BannerVariant): readonly string[] {
  if (variant === "wide") return WIDE_WORDMARK;
  if (variant === "medium") return MEDIUM_MARK;
  return [PLAIN_TEXT];
}

function truncate(text: string, width: number): string {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= 1) return chars.slice(0, width).join("");
  return chars.slice(0, width - 1).join("") + "…";
}

function metadataLine(banner: BannerModel, depth: ColorDepth, width: number): string {
  const parts = [
    `v${banner.version}`,
    banner.model,
    banner.workspace,
    `auth ${banner.authReady ? "ready" : "absent"}`,
    `approval ${banner.approvalMode}`,
  ];
  const text = truncate(parts.join(" · "), width);
  return depth === "none" ? text : `${DIM}${text}${RESET}`;
}

// Render the full banner (art rows plus a redacted metadata line) as a single
// string with no trailing newline. `width` bounds the metadata line so it never
// overflows and wraps the prompt.
export function renderProductBanner(
  banner: BannerModel,
  opts: { variant: BannerVariant; depth: ColorDepth; width?: number },
): string {
  const rows = artRows(opts.variant).map((r) => colorizeRow(r, opts.depth));
  const meta = metadataLine(banner, opts.depth, opts.width ?? Number.MAX_SAFE_INTEGER);
  return [...rows, meta].join("\n");
}

// Convenience entry point: detect capability, select the variant, redact
// metadata, and render — the single call the REPL needs at startup.
export function formatProductBanner(input: {
  version: string;
  model: string;
  workspace: string;
  authReady: boolean;
  approvalMode: string;
  width: number;
  noColor?: boolean;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}): string {
  const depth = detectColorDepth({ noColor: input.noColor, env: input.env, isTTY: input.isTTY });
  const variant = selectBannerVariant(input.width, depth);
  const banner = buildProductBanner(input);
  return renderProductBanner(banner, { variant, depth, width: input.width });
}
