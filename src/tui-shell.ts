// A stable full-screen interactive shell for the conversation experience.
//
// The shell divides the terminal into explicit regions: a compact identity
// header, a scrollable transcript that owns the main area, a fixed bottom
// composer with distinct states, and a one-line status footer. All layout,
// composer state, and rendering logic are pure functions so they can be unit
// tested without a TTY; a thin driver wires them to raw-mode input, streaming
// output, resize, and terminal cleanup. Non-interactive (`-p`), JSON, and
// diagnostic paths never touch this module, so their byte contracts are
// unaffected. The compact product wordmark (Issue #71) is integrated through
// its plain state in the identity header.

import type { Config } from "./config.js";
import type { Workspace } from "./workspace.js";
import type { ApprovalMode } from "./approval.js";
import { promptApproval } from "./approval.js";
import type { SessionMessage } from "./session.js";
import type { AgentSink, AgentUsage, AgentRetry } from "./agent.js";
import { runAgent } from "./agent.js";
import { loadImageAttachments } from "./image-input.js";
import type { LoadedImage } from "./image-input.js";
import { runPalette } from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { MEDIUM_MARK, VERSION, WIDE_WORDMARK } from "./product-banner.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Total composer band height (a state rule line plus bounded input rows).
export const COMPOSER_MAX_ROWS = 8;
export const COMPOSER_MIN_ROWS = 1;
export const IDENTITY_MAX_ROWS = 7;
export const STATUS_ROWS = 2;

// Minimum terminal dimensions before the full-screen shell is used at all; below
// these the caller falls back to the plain readline REPL so nothing clips.
export const MIN_SHELL_COLS = 20;
export const MIN_SHELL_ROWS = 4;

// Long transcript blocks collapse to this many preview lines so a single tool
// result or answer cannot push the rest of the conversation off-screen; the
// remainder stays inspectable on demand (Tab to expand the latest long block).
export const TRANSCRIPT_PREVIEW_LINES = 6;
// Continuation indent for a block's body so wrapped lines read as one entry.
const TRANSCRIPT_INDENT = "  ";
// Tool results are stored in full (redacted) up to this bound so the disclosure
// preview can be expanded without keeping unbounded output in memory.
const MAX_TOOL_TRANSCRIPT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Viewport {
  rows: number;
  cols: number;
}

// Composer states are distinguished by a glyph *and* an ASCII label, so they
// remain identifiable without relying on color alone.
export type ComposerMode =
  | "idle"
  | "focused"
  | "multiline"
  | "submitting"
  | "streaming"
  | "cancelled"
  | "disabled"
  | "error";

export interface ComposerState {
  mode: ComposerMode;
  text: string;
  placeholder: string;
}

export interface StatusInfo {
  model: string;
  // Already redacted (home collapsed to ~) by the caller; never a credential.
  workspace: string;
  approvalMode: string;
  contextUsage?: string | null;
}

export interface ShellStyle {
  bold: string;
  dim: string;
  accent: string;
  accentSoft: string;
  success: string;
  reset: string;
}

export type TranscriptKind = "user" | "assistant" | "tool" | "notice" | "error" | "streaming";

export interface TranscriptEntry {
  kind: TranscriptKind;
  text: string;
}

// Lifecycle phase of the active turn. The shell shows exactly one of these in
// place (a single indicator line) so streaming, tool execution, waiting,
// approval, interruption, failure, and completion are visible without appending
// a fresh line per state change. `idle` means no turn is in flight (the composer
// is the only live region); the terminal phases (`completed`/`failed`/
// `cancelled`) report how the last turn ended until the user engages again.
export type TurnPhase =
  | "idle"
  | "waiting"
  | "streaming"
  | "running-tool"
  | "awaiting-approval"
  | "interrupting"
  | "cancelled"
  | "failed"
  | "completed";

export interface TurnState {
  phase: TurnPhase;
  // Free-form context for the phase (e.g. the tool name while running or
  // awaiting approval); never a credential or arbitrary tool output.
  detail?: string;
}

// Events that drive the turn state machine. Kept explicit and pure so every
// transition (including the interruption outcomes) is unit-testable without a
// TTY or a live provider.
export type TurnEvent =
  | { type: "submit" }
  | { type: "stream" }
  | { type: "tool-start"; name: string }
  | { type: "approval-request"; name: string }
  | { type: "tool-result" }
  | { type: "complete" }
  | { type: "fail" }
  | { type: "interrupt" }
  | { type: "settle" }
  | { type: "engage" };

export interface ShellState {
  viewport: Viewport;
  version: string;
  transcript: TranscriptEntry[];
  composer: ComposerState;
  status: StatusInfo;
  color: boolean;
  // Active-turn lifecycle phase, rendered in place by the composer's state rule.
  turn: TurnState;
  // Indices of transcript blocks the user has expanded to full height; long
  // blocks otherwise collapse to a preview. Optional so pure render callers and
  // tests can omit it (treated as empty).
  expanded?: ReadonlySet<number>;
}

// Options controlling how transcript blocks are flattened/rendered.
export interface TranscriptRenderOptions {
  // Block indices shown in full instead of collapsed to a preview.
  expanded?: ReadonlySet<number>;
  // Preview height for collapsed long blocks.
  previewLines?: number;
  // Style used for the block header and disclosure marker (no-op when omitted).
  style?: ShellStyle;
}

export interface Region {
  start: number; // inclusive, 0-based row
  end: number; // exclusive
}

export interface ShellLayout {
  viewport: Viewport;
  identity: Region;
  transcript: Region;
  composer: Region;
  status: Region;
  identityRows: number;
  transcriptRows: number;
  composerRows: number;
  statusRows: number;
}

export interface ComposedScreen {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

// ---------------------------------------------------------------------------
// Style + small text helpers
// ---------------------------------------------------------------------------

export function shellStyle(color: boolean): ShellStyle {
  if (!color) {
    return { bold: "", dim: "", accent: "", accentSoft: "", success: "", reset: "" };
  }
  return {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    accent: "\x1b[38;5;81m",
    accentSoft: "\x1b[38;5;141m",
    success: "\x1b[38;5;114m",
    reset: "\x1b[0m",
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Visible cell width of a string, ignoring SGR color escapes.
export function visibleWidth(s: string): number {
  return Array.from(s.replace(ANSI_RE, "")).length;
}

// Hard-wrap a single line (no embedded newlines) to width cells, char-based so
// it never overflows horizontally. width <= 0 yields a single empty line.
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [""];
  const chars = Array.from(line);
  if (chars.length <= width) return [line];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += width) {
    out.push(chars.slice(i, i + width).join(""));
  }
  return out;
}

// Wrap text that may contain newlines into display lines bounded by width.
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const seg of text.split("\n")) {
    out.push(...wrapLine(seg, width));
  }
  return out.length > 0 ? out : [""];
}

// Clip a line to width, appending an ellipsis when truncated.
export function clipLine(line: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(line);
  if (chars.length <= width) return line;
  if (width === 1) return "…";
  return chars.slice(0, width - 1).join("") + "…";
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

// Allocate the four regions within a viewport. The status footer is the highest
// priority (always present when any space exists); the transcript is the
// flexible region and always keeps at least one row when room allows; the
// composer is bounded so it never crowds out the conversation; the identity
// header yields first when the terminal is very small.
export function computeLayout(viewport: Viewport, opts: { composerRows?: number } = {}): ShellLayout {
  const rows = Math.max(0, Math.floor(viewport.rows));
  const cols = Math.max(0, Math.floor(viewport.cols));
  const desiredComposer = clamp(opts.composerRows ?? COMPOSER_MIN_ROWS, COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS);

  const statusRows = rows >= 2 ? STATUS_ROWS : rows >= 1 ? 1 : 0;
  let remaining = rows - statusRows;

  // Identity scales from a full product wordmark to a compact title. Decoration
  // yields before conversation space on short or narrow terminals.
  const identityRows =
    remaining >= 17 && cols >= 44
      ? IDENTITY_MAX_ROWS
      : remaining >= 8 && cols >= 20
        ? 2
        : remaining >= 3
          ? 1
          : 0;
  remaining -= identityRows;

  // Composer: bounded, but always leave >= 1 row for the transcript when possible.
  let composerRows = remaining >= 2 ? clamp(desiredComposer, COMPOSER_MIN_ROWS, remaining - 1) : remaining;
  composerRows = clamp(composerRows, 0, COMPOSER_MAX_ROWS);
  const transcriptRows = Math.max(0, remaining - composerRows);

  const identityStart = 0;
  const transcriptStart = identityStart + identityRows;
  const composerStart = transcriptStart + transcriptRows;
  const statusStart = composerStart + composerRows;

  return {
    viewport: { rows, cols },
    identity: { start: identityStart, end: identityStart + identityRows },
    transcript: { start: transcriptStart, end: transcriptStart + transcriptRows },
    composer: { start: composerStart, end: composerStart + composerRows },
    status: { start: statusStart, end: statusStart + statusRows },
    identityRows,
    transcriptRows,
    composerRows,
    statusRows,
  };
}

// Desired total composer band height (state rule + bounded input rows).
export function composerTotalRows(text: string): number {
  const textLines = text === "" ? 1 : text.split("\n").length;
  return clamp(textLines + 2, 3, COMPOSER_MAX_ROWS);
}

// ---------------------------------------------------------------------------
// Composer state markers (color-independent)
// ---------------------------------------------------------------------------

export interface ComposerMarker {
  glyph: string;
  label: string;
}

export function composerMarker(mode: ComposerMode): ComposerMarker {
  switch (mode) {
    case "idle":
      return { glyph: ">", label: "idle" };
    case "focused":
      return { glyph: "❯", label: "edit" };
    case "multiline":
      return { glyph: "⋮", label: "multiline" };
    case "submitting":
      return { glyph: "↵", label: "submitting" };
    case "streaming":
      return { glyph: "▶", label: "streaming" };
    case "cancelled":
      return { glyph: "✕", label: "cancelled" };
    case "disabled":
      return { glyph: "‖", label: "disabled" };
    case "error":
      return { glyph: "!", label: "error" };
    default:
      return { glyph: ">", label: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Turn lifecycle (pure)
// ---------------------------------------------------------------------------

export interface TurnIndicator {
  glyph: string;
  label: string;
}

// Color-independent glyph + label for each turn phase. Every phase has a
// distinct glyph and a distinct ASCII label so the active state is identifiable
// without relying on color alone. `idle` returns an empty indicator (nothing is
// rendered in place when no turn is in flight).
export function turnIndicator(phase: TurnPhase): TurnIndicator {
  switch (phase) {
    case "waiting":
      return { glyph: "↻", label: "waiting" };
    case "streaming":
      return { glyph: "✦", label: "streaming" };
    case "running-tool":
      return { glyph: "●", label: "running tool" };
    case "awaiting-approval":
      return { glyph: "?", label: "awaiting approval" };
    case "interrupting":
      return { glyph: "…", label: "interrupting" };
    case "cancelled":
      return { glyph: "✕", label: "cancelled" };
    case "failed":
      return { glyph: "!", label: "failed" };
    case "completed":
      return { glyph: "✓", label: "completed" };
    case "idle":
    default:
      return { glyph: "", label: "" };
  }
}

// Phases in which a turn is genuinely in flight and can be interrupted.
function isActiveTurn(phase: TurnPhase): boolean {
  return (
    phase === "waiting" ||
    phase === "streaming" ||
    phase === "running-tool" ||
    phase === "awaiting-approval"
  );
}

// Phases that report how the previous turn ended; they persist in the indicator
// until the user engages again (types or submits).
function isTerminalTurn(phase: TurnPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

// Pure turn state machine. The driver feeds it lifecycle events and renders
// whatever phase it returns in place; this is the single source of truth for the
// indicator so streaming, waiting, tool execution, approval, interruption,
// failure, and completion all update one line instead of flooding the transcript.
//
// Interruption outcomes (criterion 3):
//   - interrupt while active      → "interrupting" (pending)
//   - settle while interrupting   → "cancelled"   (cancellation completed)
//   - interrupt when not active   → unchanged     (rejected: nothing to cancel)
export function advanceTurn(state: TurnState, event: TurnEvent): TurnState {
  switch (event.type) {
    case "submit":
      return { phase: "waiting" };
    case "stream":
      return { phase: "streaming" };
    case "tool-start":
      return { phase: "running-tool", detail: event.name };
    case "approval-request":
      return { phase: "awaiting-approval", detail: event.name };
    case "tool-result":
      // The round's tool finished; the next provider call is pending.
      return { phase: "waiting" };
    case "complete":
      return { phase: "completed" };
    case "fail":
      return { phase: "failed" };
    case "interrupt":
      // Only an in-flight turn can be cancelled; otherwise the request is
      // rejected (returned unchanged) so the caller can surface "nothing to
      // interrupt" rather than silently swallowing it.
      return isActiveTurn(state.phase) ? { phase: "interrupting" } : state;
    case "settle":
      // The interrupted run finished settling: the cancellation completed.
      return state.phase === "interrupting" ? { phase: "cancelled" } : state;
    case "engage":
      // The user started typing again: clear a lingering terminal outcome so the
      // composer reads as editable; active phases are left untouched.
      return isTerminalTurn(state.phase) ? { phase: "idle" } : state;
    default:
      return state;
  }
}

// Rebuild the durable transcript from a persisted conversation so a reconnect or
// resume shows prior user prompts, assistant answers, and tool results — but no
// transient turn indicators (the turn always starts `idle`). System prompts and
// contentless assistant bookkeeping (tool-call stubs) are omitted. Tool/error
// bodies are bounded so a large stored result cannot balloon memory; the block
// renderer still collapses it to an expandable preview.
export function seedTranscriptFromHistory(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  maxToolChars: number = MAX_TOOL_TRANSCRIPT_CHARS,
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") {
      if (content.trim() !== "") out.push({ kind: "user", text: content });
    } else if (m.role === "assistant") {
      if (content.trim() !== "") out.push({ kind: "assistant", text: content });
    } else if (m.role === "tool") {
      if (content.trim() === "") continue;
      const capped =
        content.length > maxToolChars ? `${content.slice(0, maxToolChars)}\n… [truncated]` : content;
      out.push({ kind: "tool", text: capped });
    }
    // system messages are never shown in the transcript.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Region renderers (pure)
// ---------------------------------------------------------------------------

function panelLine(text: string, width: number, style: ShellStyle): string {
  const inner = Math.max(0, width - 4);
  const body = clipLine(text, inner);
  return `${style.accent}│${style.reset} ${body}${" ".repeat(Math.max(0, inner - visibleWidth(body)))} ${style.accent}│${style.reset}`;
}

export function renderIdentity(
  layout: ShellLayout,
  style: ShellStyle,
  version: string,
  status: StatusInfo,
): string[] {
  const height = layout.identity.end - layout.identity.start;
  if (height <= 0) return [];
  const cols = layout.viewport.cols;
  const logoWidth = Math.max(...WIDE_WORDMARK.map((line) => visibleWidth(line)));
  const gap = 2;
  const panelWidth = Math.min(42, cols - logoWidth - gap);
  if (height >= 7 && panelWidth >= 30) {
    const panel = [
      `${style.accent}┌${"─".repeat(panelWidth - 2)}┐${style.reset}`,
      panelLine(`${style.bold}>_ OH MY CLI${style.reset}  ${style.dim}(v${version})${style.reset}`, panelWidth, style),
      panelLine("", panelWidth, style),
      panelLine(`${status.model}  (/model to change)`, panelWidth, style),
      panelLine(status.workspace, panelWidth, style),
      `${style.accent}└${"─".repeat(panelWidth - 2)}┘${style.reset}`,
    ];
    const rows = WIDE_WORDMARK.map((line, index) => {
      const tone = index < 2 ? style.accent : style.accentSoft;
      const logo = `${tone}${style.bold}${line}${style.reset}${" ".repeat(Math.max(0, logoWidth - visibleWidth(line)))}`;
      return `${logo}${" ".repeat(gap)}${panel[index] ?? ""}`;
    });
    return [
      ...rows,
      `${" ".repeat(logoWidth + gap)}${panel[5] ?? ""}`,
      `${style.dim}Tips: /attach an image for vision, or Ctrl+K to browse commands.${style.reset}`,
    ];
  }
  if (height >= 2 && cols >= 20) {
    const mark = MEDIUM_MARK[0] ?? "OMC";
    return [
      `${style.accent}${style.bold}${clipLine(mark, cols)}${style.reset}`,
      `${style.dim}${clipLine(`v${version}  ·  ${status.model}  ·  ${status.workspace}`, cols)}${style.reset}`,
    ];
  }
  return [`${style.accent}${style.bold}${clipLine(`OH MY CLI  v${version}`, cols)}${style.reset}`];
}

export function renderStatusLine(info: StatusInfo, layout: ShellLayout, style: ShellStyle): string[] {
  const height = layout.status.end - layout.status.start;
  if (height <= 0) return [];
  const cols = layout.viewport.cols;
  // Only non-secret operational state: model, redacted workspace, context usage
  // when known, and approval mode. No api key, base URL, or other credential.
  const primary = [info.workspace, info.model, info.contextUsage].filter((p): p is string => Boolean(p));
  const first = `${style.success}→${style.reset} ${style.dim}${clipLine(primary.join("  ·  "), Math.max(0, cols - 2))}${style.reset}`;
  if (height === 1) return [first];
  const second = `  ${style.dim}${clipLine(`approval ${info.approvalMode}  ·  Tab expand  ·  ? shortcuts  ·  Ctrl+C exit`, Math.max(0, cols - 2))}${style.reset}`;
  return [first, second];
}

function renderEmptyTranscript(region: Region, _cols: number, _style: ShellStyle): string[] {
  const height = Math.max(0, region.end - region.start);
  if (height === 0) return [];
  return Array.from({ length: height }, () => "");
}

// Color-independent glyph for a transcript block. The glyph + label together
// distinguish kinds without relying on color alone.
export function entryGlyph(kind: TranscriptKind): string {
  switch (kind) {
    case "user":
      return ">";
    case "assistant":
      return "◆";
    case "streaming":
      return "✦";
    case "tool":
      return "●";
    case "notice":
      return "•";
    case "error":
      return "!";
    default:
      return "•";
  }
}

// Short human label naming the speaker/source of a transcript block.
export function entryLabel(kind: TranscriptKind): string {
  switch (kind) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "streaming":
      return "Assistant";
    case "tool":
      return "Tool";
    case "notice":
      return "System";
    case "error":
      return "Error";
    default:
      return "Note";
  }
}

// Header tone per kind. Color is a bonus cue; the glyph + label carry the
// distinction when color is disabled (every style field is then "").
function entryTone(kind: TranscriptKind, style: ShellStyle): string {
  switch (kind) {
    case "user":
      return style.accent;
    case "assistant":
    case "streaming":
      return style.success;
    case "error":
      return style.bold;
    case "tool":
    case "notice":
    default:
      return style.dim;
  }
}

// Flatten transcript entries into labeled, indented blocks separated by a blank
// row so a mixed conversation reads at a glance. Long blocks collapse to a
// preview with an explicit disclosure marker; the caller can expand a block by
// index (Tab in the driver). Newest content stays anchored at the bottom via
// renderTranscript's top-padding.
export function flattenTranscript(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRenderOptions = {},
): string[] {
  const style = opts.style ?? shellStyle(false);
  const previewLines = Math.max(1, opts.previewLines ?? TRANSCRIPT_PREVIEW_LINES);
  const expanded = opts.expanded ?? new Set<number>();
  const indentWidth = Array.from(TRANSCRIPT_INDENT).length;
  const bodyWidth = Math.max(1, cols - indentWidth);
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    if (index > 0) lines.push(""); // rhythm between blocks
    const tone = entryTone(entry.kind, style);
    const header = clipLine(`${entryGlyph(entry.kind)} ${entryLabel(entry.kind)}`, cols);
    lines.push(`${tone}${header}${style.reset}`);
    const wrapped = wrapText(entry.text, bodyWidth);
    // The live streaming turn is never collapsed so the active answer stays
    // fully visible; committed blocks collapse to a preview when long.
    const collapse =
      entry.kind !== "streaming" && !expanded.has(index) && wrapped.length > previewLines;
    const shown = collapse ? wrapped.slice(0, previewLines) : wrapped;
    for (const w of shown) lines.push(TRANSCRIPT_INDENT + w);
    if (collapse) {
      const remaining = wrapped.length - shown.length;
      const marker = clipLine(`… [+${remaining} line${remaining === 1 ? "" : "s"}]`, bodyWidth);
      lines.push(`${style.dim}${TRANSCRIPT_INDENT}${marker}${style.reset}`);
    }
  });
  return lines;
}

// Render the transcript region: newest content anchored at the bottom, top-padded
// with blank rows so the composer stays put regardless of how much has scrolled.
export function renderTranscript(
  entries: TranscriptEntry[],
  region: Region,
  cols: number,
  opts: TranscriptRenderOptions = {},
): string[] {
  const height = Math.max(0, region.end - region.start);
  if (height === 0) return [];
  const flat = flattenTranscript(entries, cols, opts);
  const visible = flat.slice(Math.max(0, flat.length - height));
  while (visible.length < height) visible.unshift("");
  return visible;
}

function renderRule(label: string, cols: number, style: ShellStyle): string {
  const labelCells = Array.from(label).length;
  if (cols <= labelCells) return clipLine(label, cols);
  const fill = Math.max(0, cols - labelCells - 3);
  return `${style.accent}${"─".repeat(fill)}${style.reset} ${style.dim}${label}${style.reset} ${style.accent}─${style.reset}`;
}

function renderBottomRule(cols: number, style: ShellStyle): string {
  return `${style.accent}${"─".repeat(cols)}${style.reset}`;
}

// Render the composer band. When there is room (>= 2 rows) the first row is a
// state rule. That rule shows the active-turn phase in place when a turn is in
// flight (or reporting its outcome) so streaming/waiting/tool/approval/
// interruption/failure/completion update one line; when no turn is live it falls
// back to the composer's own mode so the input affordance stays clear. The
// remaining rows show the bounded tail of the input so the active line stays
// visible.
export function renderComposer(
  state: ComposerState,
  layout: ShellLayout,
  style: ShellStyle,
  opts: { turn?: TurnState } = {},
): string[] {
  const height = Math.max(0, layout.composer.end - layout.composer.start);
  if (height === 0) return [];
  const cols = layout.viewport.cols;
  const marker = composerMarker(state.mode);
  const turn = opts.turn;
  const indicator = turn && turn.phase !== "idle" ? turnIndicator(turn.phase) : null;
  const label = indicator
    ? `${indicator.glyph} ${indicator.label}${turn?.detail ? `: ${turn.detail}` : ""}`
    : `${marker.glyph} ${marker.label}`;
  const useFrame = height >= 3;
  const useTopRule = height >= 2;
  const textHeight = height - (useTopRule ? 1 : 0) - (useFrame ? 1 : 0);

  const lines: string[] = [];
  if (useTopRule) lines.push(renderRule(label, cols, style));

  const lead = `${marker.glyph} `;
  const bodyWidth = Math.max(1, cols - Array.from(lead).length);

  if (state.text === "") {
    const showPlaceholder =
      state.mode === "idle" || state.mode === "focused" || state.mode === "multiline";
    const ph = showPlaceholder ? clipLine(state.placeholder, bodyWidth) : "";
    lines.push(`${style.accent}${lead}${style.reset}${ph ? `${style.dim}${ph}${style.reset}` : ""}`);
  } else {
    const wrapped = wrapText(state.text, bodyWidth);
    const shown = wrapped.slice(Math.max(0, wrapped.length - textHeight));
    for (const w of shown) lines.push(`${style.accent}${lead}${style.reset}${w}`);
  }
  if (useFrame) lines.push(renderBottomRule(cols, style));
  return lines.slice(0, height);
}

// ---------------------------------------------------------------------------
// Whole-screen composition
// ---------------------------------------------------------------------------

export function composeScreen(state: ShellState): ComposedScreen {
  const style = shellStyle(state.color);
  const composerRows = composerTotalRows(state.composer.text);
  const layout = computeLayout(state.viewport, { composerRows });

  const identityLines = renderIdentity(layout, style, state.version, state.status);
  const transcriptLines =
    state.transcript.length === 0
      ? renderEmptyTranscript(layout.transcript, layout.viewport.cols, style)
      : renderTranscript(state.transcript, layout.transcript, layout.viewport.cols, {
          expanded: state.expanded,
          style,
        });
  const composerLines = renderComposer(state.composer, layout, style, { turn: state.turn });
  const statusLines = renderStatusLine(state.status, layout, style);

  const lines: string[] = [];
  lines.push(...identityLines, ...transcriptLines, ...composerLines, ...statusLines);

  const total = state.viewport.rows;
  while (lines.length < total) lines.push("");
  const clipped = lines.slice(0, total);

  // Cursor sits at the end of the composer's last rendered line.
  const composerRowCount = composerLines.length;
  const cursorRow = clamp(layout.composer.start + Math.max(0, composerRowCount - 1), 0, Math.max(0, total - 1));
  const lastComposerLine = composerRowCount > 0 ? composerLines[composerRowCount - 1] : "";
  const cursorCol = visibleWidth(lastComposerLine);

  return { lines: clipped, cursorRow, cursorCol };
}

// Convenience for tests: just the rendered rows.
export function renderShell(state: ShellState): string[] {
  return composeScreen(state).lines;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

// Whether the full-screen shell is appropriate. Falls back to the plain readline
// REPL when not a TTY, when dimensions are unknown/too small, or on a "dumb"
// terminal. Reduced color (NO_COLOR / --no-color) still uses the shell — only
// without ANSI — so it is not a fallback trigger.
export function isFullScreenCapable(opts: {
  isTTY?: boolean;
  rows?: number;
  cols?: number;
  env?: Record<string, string | undefined>;
}): boolean {
  if (!opts.isTTY) return false;
  const rows = opts.rows ?? 0;
  const cols = opts.cols ?? 0;
  if (rows < MIN_SHELL_ROWS || cols < MIN_SHELL_COLS) return false;
  const term = (opts.env?.TERM ?? "").toLowerCase();
  if (term === "dumb" || term === "") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J";
const HOME = "\x1b[H";
const RESET_ALL = "\x1b[0m";
const MOVE = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;

export interface ConversationShellOptions {
  config: Config;
  workspace: Workspace;
  approvalMode: ApprovalMode;
  sessionId: string;
  onMessage: (msg: SessionMessage) => void;
  // Returns the persisted conversation at submit time (mirrors store.load).
  loadHistory: () => SessionMessage[];
  budgetUsd?: number | null;
  // Context-pressure auto-compaction threshold (tokens); undefined disables it.
  compactThreshold?: number;
  // Folder-trust enforcement: when false, mutating tools fail closed in the
  // interactive shell too (criterion 1 requires the distinction in interactive
  // mode). Defaults to true so a non-enforcing run is unchanged.
  mutatingAllowed?: boolean;
  color: boolean;
  paletteCommands: PaletteCommand[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: Record<string, string | undefined>;
}

// Run the interactive conversation shell. Resolves never under normal operation:
// the process stays alive via stdin listeners and ends through an explicit exit
// (Ctrl+D / Ctrl+C on empty / palette /exit) that restores the terminal first.
export function runConversationShell(opts: ConversationShellOptions): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // Transcript blocks the user has expanded to full height (Tab toggles the
  // latest long block). Held outside state so the driver can mutate it; state
  // exposes it read-only to the pure renderer.
  const expanded = new Set<number>();

  // Resume from the persisted conversation: restore prior user/assistant/tool
  // messages as durable transcript blocks (redacted) so a reconnect shows the
  // conversation so far. The turn always starts idle so no stale transient
  // indicator leaks from a previous session.
  let seededTranscript: TranscriptEntry[] = [];
  try {
    seededTranscript = seedTranscriptFromHistory(opts.loadHistory()).map((e) => ({
      ...e,
      text: redactSecrets(e.text).text,
    }));
  } catch {
    seededTranscript = [];
  }

  const state: ShellState = {
    viewport: { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 },
    version: VERSION,
    transcript: seededTranscript,
    composer: { mode: "focused", text: "", placeholder: "Ask a question, or Ctrl+K for commands" },
    status: {
      model: opts.config.model,
      workspace: redactHomePath(opts.workspace.root),
      approvalMode: opts.approvalMode,
      contextUsage: null,
    },
    color: opts.color,
    turn: { phase: "idle" },
    expanded,
  };

  let running = true;
  let paletteOpen = false;
  let renderScheduled = false;
  let cleaned = false;
  // Generation guard: a cancelled run stops contributing to the UI even though
  // the underlying provider call cannot be aborted (no new provider capability).
  let runGeneration = 0;

  const write = (s: string): void => {
    stdout.write(s);
  };

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    try {
      stdin.setRawMode(false);
    } catch {
      /* not in raw mode */
    }
    stdin.pause();
    write(SHOW_CURSOR + RESET_ALL + ALT_SCREEN_OFF);
  }

  function paint(): void {
    renderScheduled = false;
    if (!running || paletteOpen) return;
    const { lines, cursorRow, cursorCol } = composeScreen(state);
    // Full, deterministic repaint: clear, home, draw every row. The transcript
    // scrolls within its region; the composer and status stay anchored, and no
    // stale scrollback is left behind during rapid streaming.
    write(HIDE_CURSOR + CLEAR + HOME);
    write(lines.join("\r\n"));
    write(MOVE(cursorRow, cursorCol) + SHOW_CURSOR);
  }

  function scheduleRender(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(paint);
  }

  function editable(): boolean {
    return (
      state.composer.mode !== "submitting" &&
      state.composer.mode !== "streaming" &&
      state.composer.mode !== "disabled"
    );
  }

  function refreshMode(): void {
    state.composer.mode = state.composer.text.includes("\n") ? "multiline" : "focused";
  }

  function insert(text: string): void {
    if (!editable()) return;
    // Typing again clears a lingering terminal outcome (completed/failed/cancelled)
    // so the indicator yields back to the editable composer.
    state.turn = advanceTurn(state.turn, { type: "engage" });
    state.composer.text += text;
    refreshMode();
    scheduleRender();
  }

  function insertNewline(): void {
    if (!editable()) return;
    state.turn = advanceTurn(state.turn, { type: "engage" });
    state.composer.text += "\n";
    state.composer.mode = "multiline";
    scheduleRender();
  }

  function backspace(): void {
    if (!editable() || state.composer.text.length === 0) return;
    state.composer.text = state.composer.text.slice(0, -1);
    refreshMode();
    scheduleRender();
  }

  // Toggle full-height display of the most recent block whose body overflows the
  // preview, so a long tool result or answer can be inspected on demand. A no-op
  // when nothing is collapsible.
  function toggleExpandLatest(): void {
    const bodyWidth = Math.max(1, state.viewport.cols - Array.from(TRANSCRIPT_INDENT).length);
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      const entry = state.transcript[i];
      if (entry.kind === "streaming") continue; // live turn is never collapsed
      if (wrapText(entry.text, bodyWidth).length > TRANSCRIPT_PREVIEW_LINES) {
        if (expanded.has(i)) expanded.delete(i);
        else expanded.add(i);
        scheduleRender();
        return;
      }
    }
  }

  function createShellSink(generation: number): AgentSink {
    const mine = (): boolean => generation === runGeneration && running;
    let streamingText = "";
    let streamingIndex = -1;

    const commitStreaming = (final: boolean, fallback: string): void => {
      if (streamingIndex >= 0) {
        if (streamingText.trim() === "") {
          state.transcript.splice(streamingIndex, 1);
        } else {
          state.transcript[streamingIndex] = { kind: "assistant", text: streamingText };
        }
      } else if (final && fallback) {
        state.transcript.push({ kind: "assistant", text: fallback });
      }
      streamingText = "";
      streamingIndex = -1;
    };

    return {
      assistantDelta: (delta) => {
        if (!mine()) return;
        streamingText += delta;
        if (streamingIndex < 0) {
          streamingIndex = state.transcript.length;
          state.transcript.push({ kind: "streaming", text: streamingText });
        } else {
          state.transcript[streamingIndex] = { kind: "streaming", text: streamingText };
        }
        state.turn = advanceTurn(state.turn, { type: "stream" });
        state.composer.mode = "streaming";
        scheduleRender();
      },
      assistantTurn: (text, _round, o) => {
        if (!mine()) return;
        commitStreaming(o.final, text);
        scheduleRender();
      },
      toolStart: ({ name }) => {
        if (!mine()) return;
        // The running tool is shown in place via the turn indicator rather than as
        // a fresh transcript line; the durable result is appended on toolResult so
        // tool execution does not flood the conversation.
        state.turn = advanceTurn(state.turn, { type: "tool-start", name });
        scheduleRender();
      },
      toolResult: ({ name, result }) => {
        if (!mine()) return;
        // Keep the result's line structure (redacted, bounded) so the block
        // renderer can wrap it and collapse it to an expandable preview rather
        // than flattening it to a single lossy line.
        const body = redactSecrets(result.content ?? "").text.replace(/\s+$/, "");
        const capped =
          body.length > MAX_TOOL_TRANSCRIPT_CHARS
            ? `${body.slice(0, MAX_TOOL_TRANSCRIPT_CHARS)}\n… [truncated]`
            : body;
        state.transcript.push({
          kind: result.isError ? "error" : "tool",
          text: `${name}: ${capped}`,
        });
        state.turn = advanceTurn(state.turn, { type: "tool-result" });
        scheduleRender();
      },
      providerError: (message) => {
        if (!mine()) return;
        state.transcript.push({ kind: "error", text: `provider error: ${redactSecrets(message).text}` });
        state.turn = advanceTurn(state.turn, { type: "fail" });
        state.composer.mode = "error";
        scheduleRender();
      },
      usage: (info: AgentUsage) => {
        if (!mine()) return;
        state.status.contextUsage = `tokens ${info.tokens.total}`;
        if (info.budgetReached && info.budgetUsd !== null) {
          state.transcript.push({ kind: "notice", text: "spend budget reached; stopping" });
        }
        scheduleRender();
      },
      retry: (info: AgentRetry) => {
        if (!mine()) return;
        state.transcript.push({
          kind: "notice",
          text: `provider retry ${info.attempt}/${info.maxAttempts} (${info.reasonClass})`,
        });
        scheduleRender();
      },
      requestApproval: async ({ name, args }) => {
        if (!mine()) return false;
        state.turn = advanceTurn(state.turn, { type: "approval-request", name });
        scheduleRender();
        // Hand the terminal back to line mode so the approval prompt's readline
        // receives a full line, then restore raw mode for the shell. The shell's
        // own data listener is paused for the duration so it does not compete
        // with readline for keystrokes.
        stdin.removeListener("data", onData);
        try {
          stdin.setRawMode(false);
        } catch {
          /* not raw */
        }
        let approved = false;
        try {
          approved = await promptApproval(name, args);
        } finally {
          if (running) {
            try {
              stdin.setRawMode(true);
            } catch {
              /* not raw */
            }
            stdin.on("data", onData);
          }
        }
        if (mine()) {
          // Approved or denied, the call is no longer awaiting input; return to the
          // running-tool phase (a denial surfaces immediately as its result).
          state.turn = advanceTurn(state.turn, { type: "tool-start", name });
          scheduleRender();
        }
        return approved;
      },
    };
  }

  // Runs are serialized so a cancelled (still-settling) run cannot interleave
  // its persisted messages with the next prompt's; the underlying provider call
  // is not aborted (no new provider capability), only its UI contribution stops.
  let submitChain: Promise<void> = Promise.resolve();

  // Images staged via /attach are sent with the next submitted prompt, then
  // cleared so they are not re-attached to later turns.
  const pendingImages: LoadedImage[] = [];

  function submit(): void {
    const text = state.composer.text.trim();
    if (!text) return;
    if (text === "/exit" || text === "/quit") {
      shutdown(0);
      return;
    }
    if (text.startsWith("/attach")) {
      state.composer.text = "";
      const paths = text.slice("/attach".length).split(/\s+/).filter(Boolean);
      if (paths.length === 0) {
        state.transcript.push({ kind: "notice", text: "usage: /attach <image-path> [more-paths...]" });
      } else {
        try {
          const loaded = loadImageAttachments(paths, opts.workspace);
          pendingImages.push(...loaded);
          state.transcript.push({
            kind: "notice",
            text: `attached ${loaded.length} image(s): ${loaded.map((i) => `${i.name} (${i.mediaType})`).join(", ")}`,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          state.transcript.push({ kind: "error", text: redactSecrets(msg).text });
        }
      }
      scheduleRender();
      return;
    }
    state.composer.text = "";
    state.composer.mode = "submitting";
    state.turn = advanceTurn(state.turn, { type: "submit" });
    state.transcript.push({ kind: "user", text });
    scheduleRender();
    const images = pendingImages.splice(0);
    submitChain = submitChain.then(() => runOne(text, images));
  }

  async function runOne(text: string, images: LoadedImage[] = []): Promise<void> {
    const generation = ++runGeneration;
    try {
      const history = opts.loadHistory();
      const result = await runAgent(text, history.slice(0, -1), {
        config: opts.config,
        workspace: opts.workspace,
        approvalMode: opts.approvalMode,
        sessionId: opts.sessionId,
        onMessage: opts.onMessage,
        sink: createShellSink(generation),
        budgetUsd: opts.budgetUsd ?? null,
        compactThreshold: opts.compactThreshold,
        mutatingAllowed: opts.mutatingAllowed ?? true,
        images,
      });
      if (generation !== runGeneration) {
        // Interrupted mid-run: its remaining output is discarded. Settle the
        // interruption in place (the indicator reads "cancelled") and restore the
        // composer so the user can continue.
        state.turn = advanceTurn(state.turn, { type: "settle" });
        state.composer.mode = "focused";
        state.transcript.push({ kind: "notice", text: "interrupted" });
        scheduleRender();
        return;
      }
      state.composer.mode = result.ok ? "focused" : "error";
      state.turn = advanceTurn(state.turn, { type: result.ok ? "complete" : "fail" });
      if (result.tokens) state.status.contextUsage = `tokens ${result.tokens.total}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (generation === runGeneration) {
        state.transcript.push({ kind: "error", text: redactSecrets(msg).text });
        state.turn = advanceTurn(state.turn, { type: "fail" });
        state.composer.mode = "error";
      }
    }
    scheduleRender();
  }

  function onCtrlC(): void {
    if (isActiveTurn(state.turn.phase)) {
      // A turn is in flight: request cancellation. It settles to "cancelled" once
      // the in-flight provider call returns (it cannot be aborted directly), so the
      // indicator first reads "interrupting" (pending) and then "cancelled".
      runGeneration++; // stop the in-flight run from contributing further
      state.turn = advanceTurn(state.turn, { type: "interrupt" });
      state.composer.mode = "cancelled";
      scheduleRender();
      return;
    }
    if (state.composer.text.length > 0) {
      state.composer.text = "";
      refreshMode();
      scheduleRender();
      return;
    }
    if (isTerminalTurn(state.turn.phase)) {
      // Nothing is running to cancel (a finished turn's outcome is still shown):
      // acknowledge the rejected request and clear the indicator instead of exiting.
      state.transcript.push({ kind: "notice", text: "nothing to interrupt" });
      state.turn = { phase: "idle" };
      scheduleRender();
      return;
    }
    shutdown(0);
  }

  function shutdown(code: number): void {
    if (!running) return;
    running = false;
    cleanup();
    stdin.removeListener("data", onData);
    stdout.removeListener("resize", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.exit(code);
  }

  async function runPaletteCommand(cmd: PaletteCommand): Promise<void> {
    // Shell-specific handling for commands whose default action would otherwise
    // bypass terminal cleanup or the shell's own state.
    if (cmd.name === "/exit" || cmd.name === "/quit") {
      shutdown(0);
      return;
    }
    if (cmd.name === "/clear") {
      state.transcript = [];
      state.turn = { phase: "idle" };
      expanded.clear();
      scheduleRender();
      return;
    }
    state.transcript.push({ kind: "notice", text: `${cmd.name} — ${cmd.description}` });
    try {
      await cmd.action();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.transcript.push({ kind: "error", text: redactSecrets(msg).text });
    }
  }

  async function openPalette(): Promise<void> {
    if (paletteOpen) return;
    paletteOpen = true;
    stdin.removeListener("data", onData);
    try {
      stdin.setRawMode(false);
    } catch {
      /* not raw */
    }
    write(CLEAR + HOME);
    const result = await runPalette(opts.paletteCommands, stdin, stdout, { color: opts.color });
    paletteOpen = false;
    try {
      stdin.setRawMode(true);
    } catch {
      /* not raw */
    }
    stdin.on("data", onData);
    if (result.selected && !result.cancelled) {
      await runPaletteCommand(result.selected);
    }
    paint();
  }

  function onData(buf: Buffer): void {
    if (paletteOpen) return;
    const s = buf.toString("utf-8");

    if (buf.length === 1) {
      const b = buf[0];
      if (b === 0x03) return onCtrlC(); // Ctrl+C
      if (b === 0x04) return shutdown(0); // Ctrl+D
      if (b === 0x0b) {
        void openPalette();
        return;
      } // Ctrl+K
      if (b === 0x0c) {
        paint();
        return;
      } // Ctrl+L redraw
      if (b === 0x09) return toggleExpandLatest(); // Tab: expand/collapse latest long block
      if (b === 0x7f || b === 0x08) return backspace();
      if (b === 0x0d || b === 0x0a) {
        submit();
        return;
      }
      if (b >= 0x20 && b < 0x7f) return insert(String.fromCharCode(b));
      return;
    }

    // Multiline insertion (Alt/Shift+Enter on common terminals).
    if (s === "\x1b\r" || s === "\x1b\n" || s === "\x1b\x0a") return insertNewline();
    // Cursor / editing sequences we intentionally treat as no-ops (cursor stays
    // at end-of-input in this slice).
    if (
      s === "\x1b[A" ||
      s === "\x1b[B" ||
      s === "\x1b[C" ||
      s === "\x1b[D" ||
      s === "\x1b[3~" ||
      s === "\x1b" ||
      s === "\x1bOH" ||
      s === "\x1bOF"
    ) {
      return;
    }

    // Otherwise treat the buffer as pasted/typed text: insert printable
    // characters and drop embedded control bytes.
    let inserted = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x0d || cp === 0x0a || cp === 0x7f || cp < 0x20) continue;
      inserted += ch;
    }
    if (inserted) insert(inserted);
  }

  function onResize(): void {
    state.viewport.rows = stdout.rows ?? state.viewport.rows;
    state.viewport.cols = stdout.columns ?? state.viewport.cols;
    scheduleRender();
  }

  function onSignal(): void {
    cleanup();
    process.exit(0);
  }

  // Enter the alternate screen and start the input loop. The shell owns signal
  // handling for its lifetime so the terminal is always restored on the way out;
  // the process-wide Ctrl+C handler is reinstated implicitly via process exit.
  write(ALT_SCREEN_ON + CLEAR + HOME);
  try {
    stdin.setRawMode(true);
  } catch {
    /* not a raw-capable stream */
  }
  stdin.on("data", onData);
  stdout.on("resize", onResize);
  process.removeAllListeners("SIGINT");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  paint();

  // The process is kept alive by the stdin listener; termination happens through
  // shutdown()/process.exit, so this promise intentionally never resolves.
  return new Promise<void>(() => {});
}
