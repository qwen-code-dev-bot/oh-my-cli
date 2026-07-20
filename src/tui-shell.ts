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
import { filterCommands, runPalette, slashPreviewQuery } from "./palette.js";
import type { PaletteCommand } from "./palette.js";
import { redactHomePath, redactSecrets } from "./permission-impact.js";
import { VERSION, WIDE_WORDMARK, colorizeBannerRow } from "./product-banner.js";
import type { ColorDepth } from "./product-banner.js";
import {
  formatRuntimeSlashCommand,
  resolveSlashCommand,
} from "./slash-command.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Total composer band height (a state rule line plus bounded input rows).
export const COMPOSER_MAX_ROWS = 8;
export const COMPOSER_MIN_ROWS = 1;
export const SLASH_PREVIEW_MAX_ITEMS = 4;
export const IDENTITY_MAX_ROWS = 7;
export const STATUS_ROWS = 2;

// Minimum terminal dimensions before the full-screen shell is used at all; below
// these the caller falls back to the plain readline REPL so nothing clips.
export const MIN_SHELL_COLS = 20;
export const MIN_SHELL_ROWS = 4;

// Long transcript blocks collapse to this many preview lines so a single tool
// result or answer cannot push the rest of the conversation off-screen; the
// remainder stays inspectable on demand (Tab expands the selected block in place,
// PageUp/PageDown scroll the transcript).
export const TRANSCRIPT_PREVIEW_LINES = 6;
// Continuation indent for a block's body so wrapped lines read as one entry.
const TRANSCRIPT_INDENT = "  ";
// Tool results are stored in full (redacted) up to this bound so the disclosure
// preview can be expanded without keeping unbounded output in memory.
const MAX_TOOL_TRANSCRIPT_CHARS = 4000;
// An expanded file diff is bounded to this many lines so a large change cannot
// flood the transcript; the complete redacted change stays available via the
// stored operation and the truncation marker names the bound (Issue #163,
// criterion 5).
const MAX_DIFF_LINES = 200;
// Line-count guard for the O(n*m) line diff: beyond this the diff falls back to a
// coarse all-removed/all-added view (still bounded) so a very large edit cannot
// blow up time or memory.
const MAX_DIFF_INPUT_LINES = 500;
// A failure's concise cause is bounded to this many characters so the summary row
// stays one line before the verbose diagnostics are expanded (Issue #163).
const MAX_FAILURE_CAUSE_CHARS = 120;
const TERMINAL_ESCAPE_KEYS = [
  "\x1b\r",
  "\x1b\n",
  "\x1b[A",
  "\x1b[B",
  "\x1b[C",
  "\x1b[D",
  "\x1bOA",
  "\x1bOB",
  "\x1bOC",
  "\x1bOD",
  "\x1b[3~",
  "\x1b[5~",
  "\x1b[6~",
  "\x1bOH",
  "\x1bOF",
] as const;

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
  accentWarm: string;
  success: string;
  reset: string;
}

export interface SlashPreviewState {
  items: readonly PaletteCommand[];
  selected: number;
}

export type EscapeInputResult =
  | { kind: "key"; key: string; rest: string }
  | { kind: "wait"; pending: string }
  | { kind: "escape"; rest: string };

export function decodeTerminalEscape(
  pending: string,
  incoming: string,
): EscapeInputResult {
  const candidate = pending + incoming;
  const key = TERMINAL_ESCAPE_KEYS.find((value) =>
    candidate.startsWith(value),
  );
  if (key) {
    return { kind: "key", key, rest: candidate.slice(key.length) };
  }
  if (TERMINAL_ESCAPE_KEYS.some((value) => value.startsWith(candidate))) {
    return { kind: "wait", pending: candidate };
  }
  return { kind: "escape", rest: candidate.slice(1) };
}

export type TranscriptKind = "user" | "assistant" | "tool" | "notice" | "error" | "streaming";

// Lifecycle state of a single tool operation, surfaced as a durable summary row
// (Issue #162, criterion 1). Each state has a stable glyph + ASCII label so it is
// identifiable without relying on color.
export type ToolOpState = "running" | "succeeded" | "failed" | "cancelled" | "approval-blocked";

// A single changed line in a file diff. The `kind` is conveyed by an ASCII prefix
// (`+`/`-`/space) at render time so additions, deletions, and context are
// distinguishable without relying on color (Issue #163, criterion 2).
export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

// A bounded, structured diff for one affected file. `added`/`removed` report the
// change magnitude so the collapsed summary can name it before expansion
// (criterion 1); `lines` is capped at MAX_DIFF_LINES with `truncated` set when the
// full change is larger (criterion 5). Every line's text is already sanitized.
export interface FileDiff {
  file: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
}

// A concise, structured failure summary shown before the verbose diagnostics
// (Issue #163, criterion 3): what went wrong (`cause`), which action it affected
// (`action`), and a safe next step (`nextStep`). All fields are sanitized.
export interface FailureDetail {
  cause: string;
  action: string;
  nextStep: string;
}

// A single tool operation rendered as a compact durable summary with progressive
// disclosure (Issue #162). Every text field is already sanitized (secrets
// redacted) by makeToolOperation, so the renderer never sees raw tool output
// (criterion 2). `turnId` attributes the operation to the agent round that owns
// it so repeated or nested tool activity stays grouped (criterion 4); `receipt`
// is an explicit pointer to the complete redacted result when `output` is bounded
// (criterion 5). `diff` (Issue #163) carries a structured change for mutating
// file tools; `failure` carries a structured cause/action/next-step for errors.
export interface ToolOperation {
  name: string;
  state: ToolOpState;
  turnId: number;
  input?: string;
  output?: string;
  durationMs?: number;
  receipt?: string;
  diff?: FileDiff;
  failure?: FailureDetail;
}

export interface TranscriptEntry {
  kind: TranscriptKind;
  text: string;
  // Structured tool operation (Issue #162). When present, the block renders as a
  // compact durable summary row with progressive disclosure instead of the flat
  // text body. Optional so existing entries and pure render callers are unaffected.
  tool?: ToolOperation;
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
  // Refines the palette when color is on: the terminal's advertised color depth
  // (basic/256/truecolor) so a reduced-color terminal gets portable 16-color SGR
  // instead of indexed codes it cannot map (Issue #164, criterion 3). Optional so
  // pure render callers and tests can omit it; composeScreen falls back to the
  // `color` boolean (true → "256", false → "none").
  colorDepth?: ColorDepth;
  // Active-turn lifecycle phase, rendered in place by the composer's state rule.
  turn: TurnState;
  // Indices of transcript blocks the user has expanded to full height; long
  // blocks otherwise collapse to a preview. Optional so pure render callers and
  // tests can omit it (treated as empty).
  expanded?: ReadonlySet<number>;
  // Lines the transcript is scrolled up from the bottom (0 = pinned to newest,
  // the default). Lets the user inspect earlier content without losing the
  // newest, and is preserved across expand/collapse (Issue #163, criterion 4).
  // Optional so pure render callers and tests can omit it (treated as 0).
  scroll?: number;
  // Whether the user has learned the basic composer flow (sent at least once,
  // or resumed with prior prompts) so the footer hints compress. Optional so
  // pure render callers and tests can omit it (treated as not-yet-learned).
  hintsLearned?: boolean;
  // Whether the in-place keyboard-shortcut help panel is shown over the main
  // area (toggled by `?` on an empty composer or the `/help` palette command,
  // dismissed by `?`/Esc/Ctrl+C). Optional so pure render callers and tests can
  // omit it (treated as closed).
  helpOpen?: boolean;
  slashPreview?: SlashPreviewState;
}

// Options controlling how transcript blocks are flattened/rendered.
export interface TranscriptRenderOptions {
  // Block indices shown in full instead of collapsed to a preview.
  expanded?: ReadonlySet<number>;
  // Preview height for collapsed long blocks.
  previewLines?: number;
  // Style used for the block header and disclosure marker (no-op when omitted).
  style?: ShellStyle;
  // Lines to scroll up from the bottom when rendering the visible window
  // (renderTranscript only; 0 = pinned to newest).
  scroll?: number;
  // When provided, flattenTranscript pushes each entry's starting line index (the
  // offset of its summary/header within the flattened output) so callers can
  // anchor scroll position to a specific event (Issue #163, criterion 4).
  startLines?: number[];
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

// Resolve the shell's color palette from a color depth. The shell honors the same
// capability model as the startup banner (product-banner): "none" emits no ANSI
// (NO_COLOR / --no-color); "basic" uses the portable 16-color SGR set so a
// reduced-color terminal renders distinct hues instead of indexed codes it cannot
// map; "256"/"truecolor" use the richer indexed palette. Every shell state also
// carries a glyph + ASCII label, so color is always a bonus cue, never the sole
// signal (Issue #164, criterion 3). Accepts a legacy boolean (true → "256",
// false → "none") so existing callers and tests are unaffected.
export function shellStyle(color: boolean | ColorDepth): ShellStyle {
  const depth: ColorDepth = typeof color === "boolean" ? (color ? "256" : "none") : color;
  if (depth === "none") {
    return {
      bold: "",
      dim: "",
      accent: "",
      accentSoft: "",
      accentWarm: "",
      success: "",
      reset: "",
    };
  }
  if (depth === "basic") {
    return {
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      accent: "\x1b[34m", // blue
      accentSoft: "\x1b[36m", // cyan
      accentWarm: "\x1b[35m", // magenta
      success: "\x1b[32m", // green
      reset: "\x1b[0m",
    };
  }
  return {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    accent: "\x1b[38;5;27m",
    accentSoft: "\x1b[38;5;45m",
    accentWarm: "\x1b[38;5;176m",
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

// Clip a line that may carry SGR color escapes to a visible cell width, preserving
// the escapes verbatim and appending an ellipsis only when the *visible* text is
// truncated. Unlike clipLine (which counts raw characters), color codes never cause
// an earlier-than-intended truncation, so a colored panel reads identically to its
// no-color form (Issue #164, criterion 3).
export function clipVisible(line: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(line) <= width) return line;
  if (width === 1) return "…";
  const target = width - 1; // reserve one cell for the ellipsis
  let out = "";
  let cells = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    // Emit a CSI/SGR escape verbatim; it occupies no visible cell.
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < n && !(line[j] >= "@" && line[j] <= "~")) j++;
      out += line.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (cells >= target) break;
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    out += ch;
    cells += 1;
    i += ch.length;
  }
  return out + "…";
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
    remaining >= 17 && cols >= 92
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
export function composerTotalRows(
  text: string,
  preview?: SlashPreviewState,
): number {
  const textLines = text === "" ? 1 : text.split("\n").length;
  const previewRows = preview
    ? 1 + Math.min(
        Math.max(1, preview.items.length),
        SLASH_PREVIEW_MAX_ITEMS,
      )
    : 0;
  return clamp(textLines + 2 + previewRows, 3, COMPOSER_MAX_ROWS);
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

// Whether a submit should proceed (criterion 3). The composer must be editable
// (not busy: submitting/streaming/disabled) and hold non-empty trimmed text, so
// busy, empty, and repeated submissions are explicit, non-destructive no-ops.
export function submitAllowed(mode: ComposerMode, text: string): boolean {
  const editable = mode !== "submitting" && mode !== "streaming" && mode !== "disabled";
  return editable && text.trim().length > 0;
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

// Decision for Ctrl+C (criterion 4): distinguish interrupting active work from
// clearing a draft, dismissing a finished turn's lingering outcome, or exiting.
// Pure so every branch is unit-testable; the driver acts on the returned outcome.
export type CancelOutcome = "interrupt" | "clear-draft" | "dismiss-outcome" | "exit";

export function cancelDecision(turn: TurnState, hasDraft: boolean): CancelOutcome {
  if (isActiveTurn(turn.phase)) return "interrupt";
  if (hasDraft) return "clear-draft";
  if (isTerminalTurn(turn.phase)) return "dismiss-outcome";
  return "exit";
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

// Extract prior user prompts (chronological, oldest first) from a persisted
// conversation so the composer can offer prompt-history recall on resume. Empty
// or whitespace-only prompts are dropped; the text is returned as stored so a
// recalled prompt reproduces exactly what was sent.
export function userPromptsFromHistory(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.trim() !== "") out.push(content);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt history (pure)
// ---------------------------------------------------------------------------

// Recall model for the composer's prompt history (criterion 2). Pure so the
// navigation boundaries (already at the oldest entry, already at the draft) are
// unit-testable without a TTY. `entries` are chronological (oldest first);
// `position === entries.length` is the live draft slot; `draft` preserves the
// in-progress text across navigation so recalling an older prompt and returning
// restores exactly what the user was typing.
export interface PromptHistory {
  entries: ReadonlyArray<string>;
  position: number;
  draft: string;
}

export function createPromptHistory(entries: ReadonlyArray<string>): PromptHistory {
  return { entries: [...entries], position: entries.length, draft: "" };
}

// Up: recall the previous (older) prompt. On the first upward move the live text
// is captured as the draft; further moves walk toward the oldest entry. No-op at
// the oldest boundary.
export function recallOlder(
  h: PromptHistory,
  currentText: string,
): { history: PromptHistory; text: string } {
  if (h.entries.length === 0 || h.position <= 0) return { history: h, text: currentText };
  const atDraft = h.position === h.entries.length;
  const draft = atDraft ? currentText : h.draft;
  const position = h.position - 1;
  return { history: { entries: h.entries, position, draft }, text: h.entries[position] };
}

// Down: recall the next (newer) prompt, restoring the preserved draft once the
// bottom boundary is reached. No-op when already at the draft.
export function recallNewer(
  h: PromptHistory,
  currentText: string,
): { history: PromptHistory; text: string } {
  if (h.position >= h.entries.length) return { history: h, text: currentText };
  const position = h.position + 1;
  const text = position === h.entries.length ? h.draft : h.entries[position];
  return { history: { entries: h.entries, position, draft: h.draft }, text };
}

// Editing recalled text commits it as the new draft and leaves navigation, so a
// recalled prompt the user modifies is not lost on the next recall.
export function commitDraft(h: PromptHistory, text: string): PromptHistory {
  return { entries: h.entries, position: h.entries.length, draft: text };
}

// A successful submit records the prompt as the newest history entry (skipping a
// consecutive duplicate) and resets navigation to a fresh draft.
export function pushPromptHistory(h: PromptHistory, text: string): PromptHistory {
  if (text.trim() === "") return { entries: h.entries, position: h.entries.length, draft: "" };
  const entries = h.entries[h.entries.length - 1] === text ? h.entries : [...h.entries, text];
  return { entries, position: entries.length, draft: "" };
}

// ---------------------------------------------------------------------------
// Tool operations (pure) — Issue #162
// ---------------------------------------------------------------------------

// Stable, color-independent marker per tool-operation state (criterion 1).
export function toolOpGlyph(state: ToolOpState): string {
  switch (state) {
    case "running":
      return "↻";
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    case "approval-blocked":
      return "⏸";
    default:
      return "●";
  }
}

// Concise text label per tool-operation state (criterion 1).
export function toolOpLabel(state: ToolOpState): string {
  switch (state) {
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "approval-blocked":
      return "approval-blocked";
    default:
      return "unknown";
  }
}

// Sanitize arbitrary tool text (input/output) for display by dropping
// credentials and embedded tokens, so neither the collapsed row nor the expanded
// detail exposes secrets (criterion 2).
export function sanitizeToolText(text: string): string {
  return redactSecrets(text).text;
}

// Human-readable duration so the summary/detail can show how long a tool took.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Bound a tool result for display, preserving an explicit path to the complete
// redacted receipt when it is truncated (criterion 5). The receipt names the
// bounded, redacted copy the transcript retains so the full result is never
// silently lost while the conversation stays readable.
export function boundToolOutput(
  output: string,
  maxChars: number = MAX_TOOL_TRANSCRIPT_CHARS,
): { output: string; receipt?: string } {
  if (output.length <= maxChars) return { output };
  const dropped = output.length - maxChars;
  return {
    output: `${output.slice(0, maxChars)}\n… [truncated ${dropped} char${dropped === 1 ? "" : "s"}]`,
    receipt: `full redacted result retained (${maxChars} char cap)`,
  };
}

// Construct a sanitized, bounded tool operation. Input and output are redacted
// and the output is bounded with an explicit receipt, so every stored operation
// is safe to render collapsed or expanded (criteria 2, 5).
export function makeToolOperation(args: {
  name: string;
  state: ToolOpState;
  turnId: number;
  input?: string;
  output?: string;
  durationMs?: number;
  maxChars?: number;
}): ToolOperation {
  const op: ToolOperation = { name: args.name, state: args.state, turnId: args.turnId };
  if (args.input !== undefined && args.input !== "") op.input = sanitizeToolText(args.input);
  if (args.durationMs !== undefined) op.durationMs = args.durationMs;
  if (args.output !== undefined && args.output !== "") {
    const bounded = boundToolOutput(sanitizeToolText(args.output), args.maxChars);
    op.output = bounded.output;
    if (bounded.receipt) op.receipt = bounded.receipt;
  }
  return op;
}

// First non-empty line of a tool's output, bounded — used as a result hint on the
// collapsed summary row so it communicates the outcome without the full body.
function toolResultHint(op: ToolOperation, maxLen = 60): string {
  if (!op.output) return "";
  const firstLine = (op.output.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
}

// Collapsed summary row for a tool operation (criteria 1, 2): a stable state
// glyph + label, the tool's purpose (name), and — when available — duration and a
// bounded, sanitized result hint. Never includes the full output or a secret.
export function toolSummaryLine(op: ToolOperation): string {
  const parts = [`${toolOpGlyph(op.state)} ${op.name}`, toolOpLabel(op.state)];
  if (typeof op.durationMs === "number") parts.push(formatDuration(op.durationMs));
  const hint = toolResultHint(op);
  if (hint) parts.push(hint);
  return parts.join("  ·  ");
}

// Expanded detail lines for a tool operation (criterion 3): sanitized input,
// output, duration, and the explicit receipt pointer. Lines are returned without
// block indentation; the renderer indents and wraps them. When the operation
// carries a structured diff the raw input (oldText/newText) is suppressed — the
// diff body, rendered separately by the caller, replaces that dump (Issue #163).
export function toolDetailLines(op: ToolOperation): string[] {
  const lines: string[] = [];
  const pushSection = (label: string, body: string): void => {
    const rows = body.split("\n");
    lines.push(`${label}: ${rows[0]}`);
    for (let i = 1; i < rows.length; i++) lines.push(rows[i]);
  };
  if (!op.diff && op.input && op.input.trim() !== "") pushSection("input", op.input);
  if (op.output && op.output.trim() !== "") pushSection("output", op.output);
  if (typeof op.durationMs === "number") lines.push(`duration: ${formatDuration(op.durationMs)}`);
  if (op.receipt) lines.push(`receipt: ${op.receipt}`);
  return lines;
}

// Whether a tool operation has hidden detail that progressive disclosure can
// reveal (criterion 3). A running operation with no output yet has nothing to
// expand; a diff is always expandable so the change can be inspected.
export function toolOpHasDetail(op: ToolOperation): boolean {
  return toolDetailLines(op).length > 0 || op.diff !== undefined;
}

// ---------------------------------------------------------------------------
// Diff inspection (Issue #163, pure)
// ---------------------------------------------------------------------------

// Line-level diff between two texts via a longest-common-subsequence backtrack.
// Context (unchanged) lines are interleaved with additions/deletions so the change
// reads in place. Inputs are split on "\n"; an empty string yields no lines.
// Callers bound the inputs (see buildFileDiff) before reaching here.
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j] });
    j++;
  }
  return out;
}

// Coarse fallback diff when inputs exceed the LCS guard: every old line is a
// deletion and every new line an addition. Honest about magnitude, bounded, and
// deterministic so a very large edit cannot blow up the O(n*m) backtrack.
function coarseDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  if (oldText !== "") for (const l of oldText.split("\n")) out.push({ kind: "del", text: l });
  if (newText !== "") for (const l of newText.split("\n")) out.push({ kind: "add", text: l });
  return out;
}

// Build a bounded, sanitized FileDiff from before/after text. The added/removed
// counts reflect the full change magnitude (criterion 1); the stored line list is
// capped at MAX_DIFF_LINES with `truncated` marking a larger change (criterion 5).
// Every line is secret-redacted so an expanded diff never exposes credentials.
export function buildFileDiff(file: string, oldText: string, newText: string): FileDiff {
  const oldLines = oldText === "" ? 0 : oldText.split("\n").length;
  const newLines = newText === "" ? 0 : newText.split("\n").length;
  const all =
    oldLines <= MAX_DIFF_INPUT_LINES && newLines <= MAX_DIFF_INPUT_LINES
      ? diffLines(oldText, newText)
      : coarseDiff(oldText, newText);
  const added = all.filter((l) => l.kind === "add").length;
  const removed = all.filter((l) => l.kind === "del").length;
  const truncated = all.length > MAX_DIFF_LINES;
  const kept = truncated ? all.slice(0, MAX_DIFF_LINES) : all;
  return {
    file,
    added,
    removed,
    lines: kept.map((l) => ({ kind: l.kind, text: sanitizeToolText(l.text) })),
    truncated,
  };
}

// Derive a structured FileDiff from a mutating file tool's arguments: `edit`
// diffs oldText→newText for the touched file; `write` treats the written content
// as additions (the prior content is unknown to the tool). Returns undefined for
// non-file tools, missing paths, or no-op edits.
export function deriveFileDiff(name: string, args: Record<string, unknown>): FileDiff | undefined {
  const file = typeof args.path === "string" && args.path !== "" ? args.path : undefined;
  if (!file) return undefined;
  if (name === "edit") {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    if (oldText === newText) return undefined;
    return buildFileDiff(file, oldText, newText);
  }
  if (name === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content === "") return undefined;
    return buildFileDiff(file, "", content);
  }
  return undefined;
}

// Collapsed diff summary line naming the affected file and change magnitude so the
// user can gauge the change before expanding (criterion 1).
export function diffStatLine(diff: FileDiff): string {
  return `${diff.file}  +${diff.added} -${diff.removed}`;
}

// ASCII prefix per diff-line kind: the color-independent cue that distinguishes
// additions, deletions, and context (criterion 2).
export function diffLinePrefix(kind: DiffLineKind): string {
  if (kind === "add") return "+ ";
  if (kind === "del") return "- ";
  return "  ";
}

// Render a bounded diff body as plain prefixed lines (no color, no clipping) so the
// renderer can clip and colorize them consistently. The truncation marker names the
// bound and that the complete redacted change is retained (criterion 5).
export function renderDiffBody(diff: FileDiff): string[] {
  const out = diff.lines.map((l) => `${diffLinePrefix(l.kind)}${l.text}`);
  if (diff.truncated) {
    out.push(`… [diff truncated to ${MAX_DIFF_LINES} lines; full redacted change retained]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure inspection (Issue #163, pure)
// ---------------------------------------------------------------------------

// First non-empty, trimmed line of a block, bounded and sanitized — used as a
// failure's concise cause (criterion 3).
function firstMeaningfulLine(text: string, maxLen = MAX_FAILURE_CAUSE_CHARS): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const clean = sanitizeToolText(line);
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

// The action a failing tool was performing, named concisely from its (sanitized)
// arguments so the summary points at the offending target (criterion 3).
export function failureAction(name: string, args: Record<string, unknown>): string {
  const str = (key: string, max = 80): string | undefined => {
    const v = args[key];
    if (typeof v !== "string" || v.trim() === "") return undefined;
    const t = sanitizeToolText(v.trim());
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  switch (name) {
    case "edit":
    case "write":
    case "read":
    case "list": {
      const p = str("path");
      return p ? `${name} ${p}` : name;
    }
    case "glob": {
      const p = str("pattern");
      return p ? `glob ${p}` : "glob";
    }
    case "grep": {
      const p = str("pattern");
      return p ? `grep ${p}` : "grep";
    }
    case "shell": {
      const c = str("command");
      return c ? `shell ${c}` : "shell";
    }
    default:
      return name;
  }
}

// A safe, deterministic next step inferred from the failure's cause and tool, so
// the summary tells the user how to proceed before the raw diagnostics
// (criterion 3).
export function suggestNextStep(cause: string, name: string): string {
  const c = cause.toLowerCase();
  // Permission failures are checked before the (narrower) user-denial match so a
  // message like "permission denied" is not misread as an approval rejection.
  if (/permission denied|eacces|eperm/.test(c)) return "check permissions for this path";
  if (/denied by user/.test(c)) return "approve the action or adjust the request";
  if (/not unique|appears \d+ times|single occurrence|multiple times/.test(c))
    return "narrow oldText to a unique, exact match";
  if (/no such file|not found|enoent/.test(c)) {
    if (name === "shell") return "verify the command exists and is on PATH";
    return "check the path and retry";
  }
  if (/timed out|timeout/.test(c)) return "narrow the operation's scope or raise the timeout";
  return "review the diagnostic and retry";
}

// Derive a structured failure summary from a tool error result. Returns undefined
// for non-error results. Every field is sanitized and the cause is bounded to one
// line (criterion 3).
export function deriveFailure(
  name: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
): FailureDetail | undefined {
  if (!result.isError) return undefined;
  const cause = firstMeaningfulLine(result.content) || "tool reported an error";
  return {
    cause,
    action: failureAction(name, args),
    nextStep: suggestNextStep(cause, name),
  };
}

// Collapsed failure summary lines: cause, affected action, and safe next step,
// shown before the verbose diagnostics (criterion 3).
export function renderFailureSummary(failure: FailureDetail): string[] {
  return [`cause: ${failure.cause}`, `action: ${failure.action}`, `next: ${failure.nextStep}`];
}

// Expand-marker label for a tool operation, naming what disclosure reveals so the
// collapsed row tells the user what they will get (Issue #163).
export function toolExpandMarker(op: ToolOperation): string {
  if (op.diff && op.failure) return "… [expand for diff and diagnostics]";
  if (op.diff) return "… [expand for diff]";
  if (op.failure) return "… [expand for diagnostics]";
  return "… [expand for input/output]";
}

// Color tone for a rendered diff body line, chosen by its ASCII prefix. Color is a
// bonus cue only; the prefix already carries the distinction (criterion 2), so a
// no-color style returns "" for every line.
function diffBodyTone(line: string, style: ShellStyle): string {
  if (line.startsWith("+ ")) return style.success;
  if (line.startsWith("- ")) return style.bold;
  return style.dim;
}

// ---------------------------------------------------------------------------
// Region renderers (pure)
// ---------------------------------------------------------------------------

export function renderIdentity(
  layout: ShellLayout,
  style: ShellStyle,
  version: string,
  status: StatusInfo,
  depth: ColorDepth = "none",
): string[] {
  const height = layout.identity.end - layout.identity.start;
  if (height <= 0) return [];
  const cols = layout.viewport.cols;
  const logoWidth = Math.max(...WIDE_WORDMARK.map((line) => visibleWidth(line)));
  if (height >= 7 && cols >= logoWidth) {
    const rows = WIDE_WORDMARK.map((line) => colorizeBannerRow(line, depth));
    return [
      ...rows,
      `${style.dim}Tips: Type / to browse commands; /attach adds images.${style.reset}`,
    ];
  }
  if (height >= 2 && cols >= 20) {
    return [
      `${style.accent}${style.bold}${clipLine("Qwen3.8-Max", cols)}${style.reset}`,
      `${style.dim}${clipLine(`v${version}  ·  ${status.model}  ·  ${status.workspace}`, cols)}${style.reset}`,
    ];
  }
  return [`${style.accent}${style.bold}${clipLine(`Qwen3.8-Max  v${version}`, cols)}${style.reset}`];
}

// Composer-facing footer hints (criterion 1). They name the real terminal key
// behavior and compress once the user has learned the basic flow (sent at least
// once) so the footer stays calm; the discovery affordances (Tab, ? shortcuts,
// Ctrl+C) remain in both states. Plain ASCII, color-independent.
export function footerHints(learned: boolean): string {
  return learned
    ? "Tab expand  ·  ? shortcuts  ·  Ctrl+C exit"
    : "Enter send  ·  Alt+Enter newline  ·  Up history  ·  Tab expand  ·  ? shortcuts  ·  Ctrl+C exit";
}

export function renderStatusLine(
  info: StatusInfo,
  layout: ShellLayout,
  style: ShellStyle,
  opts: { learned?: boolean; scroll?: number } = {},
): string[] {
  const height = layout.status.end - layout.status.start;
  if (height <= 0) return [];
  const cols = layout.viewport.cols;
  // Only non-secret operational state: model, redacted workspace, context usage
  // when known, and approval mode. No api key, base URL, or other credential.
  const primary = [info.workspace, info.model, info.contextUsage].filter((p): p is string => Boolean(p));
  const first = `${style.success}→${style.reset} ${style.dim}${clipLine(primary.join("  ·  "), Math.max(0, cols - 2))}${style.reset}`;
  if (height === 1) return [first];
  // When the transcript is scrolled up from the newest, a textual marker gives the
  // navigation a visible focus (and names how far up) so keyboard-only users know
  // they are inspecting earlier content rather than the live tail (Issue #164,
  // criterion 4). It is plain ASCII so it reads with or without color.
  const scrolled = (opts.scroll ?? 0) > 0 ? `↑ ${opts.scroll} up  ·  ` : "";
  const secondInner = `${scrolled}approval ${info.approvalMode}  ·  ${footerHints(opts.learned ?? false)}`;
  const second = `  ${style.dim}${clipLine(secondInner, Math.max(0, cols - 2))}${style.reset}`;
  return [first, second];
}

// ---------------------------------------------------------------------------
// Keyboard-shortcut help panel (Issue #169)
// ---------------------------------------------------------------------------

// A single shortcut entry: the key chord and what it does. These are the REAL
// bindings wired into the driver's input loop, so the panel never advertises a
// shortcut the shell does not honor. Plain ASCII text; color is a bonus cue.
export interface ShortcutEntry {
  keys: string;
  action: string;
}

// The live shortcut set. `?` and Esc are the panel's own toggle/dismiss; the
// rest mirror the driver's onData bindings.
export const SHORTCUT_HELP: ReadonlyArray<ShortcutEntry> = [
  { keys: "Enter", action: "Send the prompt" },
  { keys: "Alt+Enter / Shift+Enter", action: "Insert a new line" },
  { keys: "Ctrl+K", action: "Open the command palette" },
  { keys: "Tab", action: "Expand or collapse the selected block" },
  { keys: "Up / Down", action: "Recall a previous prompt" },
  { keys: "PageUp / PageDown", action: "Scroll the transcript" },
  { keys: "Ctrl+L", action: "Redraw the screen" },
  { keys: "Ctrl+C", action: "Interrupt, clear draft, or exit" },
  { keys: "Ctrl+D", action: "Exit" },
  { keys: "?", action: "Toggle this help panel" },
  { keys: "Esc", action: "Close this help panel" },
];

// Stable title naming the panel; also used by tests to assert the panel never
// leaks into non-interactive output.
export const SHORTCUT_HELP_TITLE = "Keyboard shortcuts";

// Whether a `?` keystroke should toggle the help panel instead of inserting the
// character (Issue #169): only on an empty composer. With any text the `?` is
// typed as usual. Pure so the toggle rule is unit-testable without a TTY.
export function questionMarkOpensHelp(composerText: string): boolean {
  return composerText.length === 0;
}

// Pure renderer for the in-place keyboard-shortcut help panel (Issue #169).
// Returns content lines (a title, the real shortcuts, and a dismiss hint), each
// bounded to `width` visible cells so the panel never overflows horizontally and
// reads identically with or without color (style may be omitted, and every row
// carries plain ASCII regardless). The content is static, so it can never carry
// a secret or a host path.
export function renderShortcutHelp(width: number, style?: ShellStyle): string[] {
  const w = Math.max(0, Math.floor(width));
  const s = style ?? {
    bold: "",
    dim: "",
    accent: "",
    accentSoft: "",
    accentWarm: "",
    success: "",
    reset: "",
  };
  const keyCol = SHORTCUT_HELP.reduce((m, e) => Math.max(m, visibleWidth(e.keys)), 0);
  const out: string[] = [];
  out.push(clipVisible(`${s.bold}${s.accent}? ${SHORTCUT_HELP_TITLE}${s.reset}`, w));
  out.push(clipVisible(`${s.dim}Press ? or Esc to close${s.reset}`, w));
  out.push("");
  for (const e of SHORTCUT_HELP) {
    const keys = e.keys.padEnd(keyCol, " ");
    out.push(clipVisible(`  ${s.accent}${keys}${s.reset}  ${s.dim}${e.action}${s.reset}`, w));
  }
  return out;
}

// Fill a region of `height` rows with the centered help panel, clipping the
// content when the region is shorter than the panel so it never overflows.
function renderShortcutHelpPanel(height: number, cols: number, style: ShellStyle): string[] {
  const h = Math.max(0, Math.floor(height));
  if (h === 0) return [];
  const content = renderShortcutHelp(cols, style);
  const body = content.slice(0, h);
  const padTop = Math.floor((h - body.length) / 2);
  const out: string[] = [];
  for (let i = 0; i < padTop; i++) out.push("");
  out.push(...body);
  while (out.length < h) out.push("");
  return out;
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
    // Record where this entry's block begins (its summary/header line) so callers
    // can anchor scroll position to a specific event (Issue #163, criterion 4).
    opts.startLines?.push(lines.length);
    // Structured tool operation: a compact durable summary row with progressive
    // disclosure (Issue #162). Collapsed shows the summary, a diff's file +
    // magnitude (Issue #163, criterion 1), and a failure's cause/action/next-step
    // (criterion 3) before an expand marker; expanded reveals the bounded
    // input/output/duration/receipt plus the diff body with +/-/context markers
    // (criteria 2, 3, 5).
    if (entry.tool) {
      const op = entry.tool;
      const tone = entryTone(entry.kind, style);
      lines.push(`${tone}${clipLine(toolSummaryLine(op), cols)}${style.reset}`);
      // Diff magnitude is shown collapsed so the change is gauged before expansion.
      if (op.diff) {
        const stat = clipLine(diffStatLine(op.diff), bodyWidth);
        lines.push(`${style.dim}${TRANSCRIPT_INDENT}${stat}${style.reset}`);
      }
      // Failure summary is shown collapsed so cause/action/next-step precede the
      // verbose diagnostics (criterion 3).
      if (op.failure) {
        for (const fl of renderFailureSummary(op.failure)) {
          lines.push(`${style.dim}${TRANSCRIPT_INDENT}${clipLine(fl, bodyWidth)}${style.reset}`);
        }
      }
      if (toolOpHasDetail(op)) {
        if (expanded.has(index)) {
          for (const dl of toolDetailLines(op)) {
            for (const w of wrapText(dl, bodyWidth)) lines.push(TRANSCRIPT_INDENT + w);
          }
          // Diff body: clipped (code-like, not wrapped) and colorized by prefix;
          // the +/-/space prefix carries the add/del/context distinction without
          // relying on color (criterion 2).
          if (op.diff) {
            for (const bl of renderDiffBody(op.diff)) {
              const dt = diffBodyTone(bl, style);
              lines.push(`${dt}${TRANSCRIPT_INDENT}${clipLine(bl, bodyWidth)}${style.reset}`);
            }
          }
        } else {
          const marker = clipLine(toolExpandMarker(op), bodyWidth);
          lines.push(`${style.dim}${TRANSCRIPT_INDENT}${marker}${style.reset}`);
        }
      }
      return;
    }
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

// Render the transcript region: newest content anchored at the bottom by default,
// top-padded with blank rows so the composer stays put. `opts.scroll` lifts the
// window up from the bottom (0 = pinned to newest) so earlier content is
// inspectable; it is clamped so the window never runs past the top.
export function renderTranscript(
  entries: TranscriptEntry[],
  region: Region,
  cols: number,
  opts: TranscriptRenderOptions = {},
): string[] {
  const height = Math.max(0, region.end - region.start);
  if (height === 0) return [];
  const flat = flattenTranscript(entries, cols, opts);
  const maxScroll = Math.max(0, flat.length - height);
  const scroll = clamp(Math.floor(opts.scroll ?? 0), 0, maxScroll);
  const end = flat.length - scroll;
  const start = Math.max(0, end - height);
  const visible = flat.slice(start, end);
  while (visible.length < height) visible.unshift("");
  return visible;
}

// First flattened line index of each transcript entry (its summary/header line),
// computed with the same options that affect layout (notably `expanded`). Used to
// anchor scroll position to a specific event across expand/collapse (Issue #163).
export function entryStartLines(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRenderOptions = {},
): number[] {
  const startLines: number[] = [];
  flattenTranscript(entries, cols, { ...opts, startLines });
  return startLines;
}

// Scroll offset (lines up from the bottom) that keeps a selected event's first
// line at the same viewport row after the transcript changes — e.g. an
// expand/collapse — so opening/closing details never displaces the content the
// user was looking at (Issue #163, criterion 4). The result is clamped to the
// scrollable range for the after-state.
export function scrollToKeepAnchor(params: {
  flatLenBefore: number;
  flatLenAfter: number;
  anchorBefore: number;
  anchorAfter: number;
  scrollBefore: number;
  height: number;
}): number {
  const { flatLenBefore, flatLenAfter, anchorBefore, anchorAfter, scrollBefore, height } = params;
  // The anchor's viewport row is anchorLine - topIndex, where the window's top
  // index is flatLen - scroll - height. Holding that row constant across the
  // change solves to: scrollAfter = scrollBefore + ΔflatLen - ΔanchorLine.
  const raw = scrollBefore + (flatLenAfter - flatLenBefore) - (anchorAfter - anchorBefore);
  const maxScroll = Math.max(0, flatLenAfter - height);
  return clamp(Math.floor(raw), 0, maxScroll);
}

// Scroll offset (lines up from the bottom) that keeps the transcript's top-visible
// entry in place across a terminal resize, so reflowing the same content at a new
// width/height never displaces what the user was reading (Issue #164, criterion 5).
// A bottom-pinned view (scroll 0) stays bottom-pinned so a resize never yanks the
// user into earlier content; the height change is accounted for explicitly so a
// shorter or taller transcript region keeps the anchor at the same viewport row.
export function resizeScrollOffset(params: {
  entries: TranscriptEntry[];
  expanded?: ReadonlySet<number>;
  oldCols: number;
  newCols: number;
  scrollBefore: number;
  heightBefore: number;
  heightAfter: number;
}): number {
  const { entries, oldCols, newCols, scrollBefore, heightBefore, heightAfter } = params;
  if (scrollBefore <= 0 || heightAfter <= 0 || entries.length === 0) return 0;
  const expanded = params.expanded ?? new Set<number>();
  const beforeStarts = entryStartLines(entries, oldCols, { expanded });
  const flatLenBefore = flattenTranscript(entries, oldCols, { expanded }).length;
  const flatLenAfter = flattenTranscript(entries, newCols, { expanded }).length;
  const afterStarts = entryStartLines(entries, newCols, { expanded });
  // The window's top flat-line index before the resize, and the newest entry whose
  // block starts at or above it (the anchor whose position we hold).
  const startBefore = Math.max(0, flatLenBefore - scrollBefore - heightBefore);
  const topIndex = clamp(startBefore, 0, Math.max(0, flatLenBefore - 1));
  let anchor = 0;
  for (let i = 0; i < beforeStarts.length; i++) {
    if ((beforeStarts[i] ?? 0) <= topIndex) anchor = i;
    else break;
  }
  // Hold the anchor's first line at its current viewport row: row = startLine -
  // windowTop. Solving for the after-scroll that preserves that row (allowing for
  // the region height changing) gives the offset below, clamped to the valid range.
  const rowBefore = (beforeStarts[anchor] ?? 0) - startBefore;
  const raw = flatLenAfter - heightAfter - (afterStarts[anchor] ?? 0) + rowBefore;
  const maxScroll = Math.max(0, flatLenAfter - heightAfter);
  return clamp(Math.floor(raw), 0, maxScroll);
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
  opts: { turn?: TurnState; slashPreview?: SlashPreviewState } = {},
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
  const preview = opts.slashPreview;
  const previewRows = preview
    ? 1 + Math.min(
        Math.max(1, preview.items.length),
        SLASH_PREVIEW_MAX_ITEMS,
      )
    : 0;
  const textHeight = Math.max(
    1,
    height -
      (useTopRule ? 1 : 0) -
      (useFrame ? 1 : 0) -
      previewRows,
  );

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
  if (preview) {
    const total = preview.items.length;
    const selected = clamp(preview.selected, 0, Math.max(0, total - 1));
    const position = total === 0 ? "0/0" : `${selected + 1}/${total}`;
    const hints = `COMMANDS ${position}  ↑↓ select · Tab complete · Esc close`;
    lines.push(clipVisible(`${style.dim}${hints}${style.reset}`, cols));

    if (total === 0) {
      lines.push(
        clipVisible(
          `${style.accentWarm}◇${style.reset} ${style.dim}No matching commands${style.reset}`,
          cols,
        ),
      );
    } else {
      const visible = Math.min(total, SLASH_PREVIEW_MAX_ITEMS);
      const start = clamp(selected - visible + 1, 0, Math.max(0, total - visible));
      for (let index = start; index < start + visible; index++) {
        const command = preview.items[index];
        const active = index === selected;
        const marker = active
          ? `${style.accentSoft}◆${style.reset}`
          : `${style.dim}·${style.reset}`;
        const name = active
          ? `${style.bold}${style.accent}${command.name}${style.reset}`
          : command.name;
        const description = active
          ? `${style.accentWarm}${command.description}${style.reset}`
          : `${style.dim}${command.description}${style.reset}`;
        lines.push(clipVisible(`${marker} ${name}  ${description}`, cols));
      }
    }
  }
  if (useFrame) lines.push(renderBottomRule(cols, style));
  return lines.slice(0, height);
}

// ---------------------------------------------------------------------------
// Whole-screen composition
// ---------------------------------------------------------------------------

export function composeScreen(state: ShellState): ComposedScreen {
  const depth: ColorDepth = state.colorDepth ?? (state.color ? "256" : "none");
  const style = shellStyle(depth);
  const composerRows = composerTotalRows(
    state.composer.text,
    state.slashPreview,
  );
  const layout = computeLayout(state.viewport, { composerRows });

  const composerLines = renderComposer(state.composer, layout, style, {
    turn: state.turn,
    slashPreview: state.slashPreview,
  });
  const statusLines = renderStatusLine(state.status, layout, style, {
    learned: state.hintsLearned ?? false,
    scroll: state.scroll,
  });

  const lines: string[] = [];
  if (state.helpOpen) {
    // The help panel takes over the main area above the composer (identity +
    // transcript) so the full shortcut list is visible in place; the composer
    // and status stay anchored, so dismissing it returns to the same
    // conversation (Issue #169).
    lines.push(...renderShortcutHelpPanel(layout.composer.start, layout.viewport.cols, style));
  } else {
    const identityLines = renderIdentity(layout, style, state.version, state.status, depth);
    const transcriptLines =
      state.transcript.length === 0
        ? renderEmptyTranscript(layout.transcript, layout.viewport.cols, style)
        : renderTranscript(state.transcript, layout.transcript, layout.viewport.cols, {
            expanded: state.expanded,
            scroll: state.scroll,
            style,
          });
    lines.push(...identityLines, ...transcriptLines);
  }
  lines.push(...composerLines, ...statusLines);

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
  // The terminal's advertised color depth, so the shell renders with a palette the
  // terminal can actually display (basic 16-color on reduced-color terminals).
  // Optional; when omitted the shell derives depth from `color` (true → "256").
  colorDepth?: ColorDepth;
  paletteCommands: PaletteCommand[];
  settingsPath: string;
  tools: readonly string[];
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

  // In-flight tool operations keyed by tool-call id, so each operation updates
  // its own durable summary row in place (start → result) even when tools repeat
  // or nest within a round (Issue #162, criterion 4). The start time backs the
  // duration when the tool does not report elapsedMs itself; the parsed args back
  // the structured diff/failure derived when the result arrives (Issue #163).
  const runningTools = new Map<
    string,
    { index: number; start: number; args?: Record<string, unknown> }
  >();

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

  // Seed prompt-history recall from prior user prompts so a resume can recall
  // them with Up/Down. Returning users (with prior prompts) start with the
  // compressed footer hints since they have already learned the basic flow.
  let history: PromptHistory;
  try {
    history = createPromptHistory(userPromptsFromHistory(opts.loadHistory()));
  } catch {
    history = createPromptHistory([]);
  }

  const state: ShellState = {
    viewport: { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 },
    version: VERSION,
    transcript: seededTranscript,
    composer: {
      mode: "focused",
      text: "",
      placeholder: "Ask a question, or type / for commands",
    },
    status: {
      model: opts.config.model,
      workspace: redactHomePath(opts.workspace.root),
      approvalMode: opts.approvalMode,
      contextUsage: null,
    },
    color: opts.color,
    colorDepth: opts.colorDepth,
    turn: { phase: "idle" },
    expanded,
    scroll: 0,
    hintsLearned: history.entries.length > 0,
    helpOpen: false,
  };

  let running = true;
  let paletteOpen = false;
  let renderScheduled = false;
  let cleaned = false;
  // Generation guard: a cancelled run stops contributing to the UI even though
  // the underlying provider call cannot be aborted (no new provider capability).
  let runGeneration = 0;
  let slashPreviewDismissedFor: string | null = null;
  let escapeBuffer = "";
  let escapeTimer: NodeJS.Timeout | null = null;

  const write = (s: string): void => {
    stdout.write(s);
  };

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    if (escapeTimer) clearTimeout(escapeTimer);
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

  function refreshSlashPreview(resetSelection = false): void {
    const query = slashPreviewQuery(state.composer.text);
    if (
      query === null ||
      slashPreviewDismissedFor === state.composer.text
    ) {
      state.slashPreview = undefined;
      return;
    }
    const items = filterCommands(opts.paletteCommands, query);
    const previous = resetSelection ? 0 : (state.slashPreview?.selected ?? 0);
    state.slashPreview = {
      items,
      selected: clamp(previous, 0, Math.max(0, items.length - 1)),
    };
  }

  function moveSlashSelection(delta: number): void {
    const preview = state.slashPreview;
    if (!preview || preview.items.length === 0) return;
    const count = preview.items.length;
    preview.selected = (preview.selected + delta + count) % count;
    scheduleRender();
  }

  function completeSlashSelection(run: boolean): void {
    const preview = state.slashPreview;
    const command = preview?.items[preview.selected];
    if (!command) return;
    state.composer.text = command.name;
    history = commitDraft(history, state.composer.text);
    slashPreviewDismissedFor = run ? state.composer.text : null;
    refreshMode();
    refreshSlashPreview();
    if (run) submit();
    else scheduleRender();
  }

  function dismissSlashPreview(): void {
    if (!state.slashPreview) return;
    slashPreviewDismissedFor = state.composer.text;
    state.slashPreview = undefined;
    scheduleRender();
  }

  function insert(text: string): void {
    if (!editable()) return;
    // Typing again clears a lingering terminal outcome (completed/failed/cancelled)
    // so the indicator yields back to the editable composer.
    state.turn = advanceTurn(state.turn, { type: "engage" });
    state.composer.text += text;
    slashPreviewDismissedFor = null;
    // Editing commits the visible text as the draft and leaves history navigation
    // so a recalled prompt the user modifies is not lost on the next recall.
    history = commitDraft(history, state.composer.text);
    refreshMode();
    refreshSlashPreview(true);
    scheduleRender();
  }

  function insertNewline(): void {
    if (!editable()) return;
    state.turn = advanceTurn(state.turn, { type: "engage" });
    state.composer.text += "\n";
    slashPreviewDismissedFor = null;
    state.composer.mode = "multiline";
    refreshSlashPreview(true);
    history = commitDraft(history, state.composer.text);
    scheduleRender();
  }

  function backspace(): void {
    if (!editable() || state.composer.text.length === 0) return;
    state.composer.text = state.composer.text.slice(0, -1);
    slashPreviewDismissedFor = null;
    history = commitDraft(history, state.composer.text);
    refreshMode();
    refreshSlashPreview(true);
    scheduleRender();
  }

  // In-place keyboard-shortcut help panel (Issue #169). `?` on an empty composer
  // toggles it; `?` again, Esc, or Ctrl+C dismisses it. While open the panel is
  // modal: every other key is ignored so nothing is typed behind it.
  function openHelp(): void {
    if (state.helpOpen) return;
    state.helpOpen = true;
    scheduleRender();
  }

  function closeHelp(): void {
    if (!state.helpOpen) return;
    state.helpOpen = false;
    scheduleRender();
  }

  function toggleHelp(): void {
    state.helpOpen = !state.helpOpen;
    scheduleRender();
  }

  // Prompt-history recall (criterion 2). This slice keeps the caret at
  // end-of-input (no intra-text cursor movement), so Up/Down recall previous
  // prompts without hijacking cursor movement; the in-progress draft is preserved
  // and restored when returning to the bottom. Recalling is also engaging with
  // the composer, so it clears a lingering terminal turn outcome.
  function recallPrevious(): void {
    if (!editable()) return;
    state.turn = advanceTurn(state.turn, { type: "engage" });
    const r = recallOlder(history, state.composer.text);
    history = r.history;
    state.composer.text = r.text;
    slashPreviewDismissedFor = null;
    refreshMode();
    refreshSlashPreview(true);
    scheduleRender();
  }

  function recallNext(): void {
    if (!editable()) return;
    state.turn = advanceTurn(state.turn, { type: "engage" });
    const r = recallNewer(history, state.composer.text);
    history = r.history;
    state.composer.text = r.text;
    slashPreviewDismissedFor = null;
    refreshMode();
    refreshSlashPreview(true);
    scheduleRender();
  }

  // Height of the transcript region for the current viewport/composer, used to
  // bound scrolling and to anchor the view across expand/collapse.
  function transcriptHeight(): number {
    const composerRows = composerTotalRows(
      state.composer.text,
      state.slashPreview,
    );
    return computeLayout(state.viewport, { composerRows }).transcriptRows;
  }

  function flattenedLen(): number {
    return flattenTranscript(state.transcript, state.viewport.cols, { expanded }).length;
  }

  // The newest expandable transcript block currently within the window: the last
  // entry whose block starts above the window's bottom edge. At the bottom
  // (scroll 0) this is simply the latest expandable block, preserving the prior
  // one-keystroke inspect behavior; scrolled up, it is the newest block on screen.
  function selectedExpandableIndex(startLines: number[], windowBottom: number): number {
    const bodyWidth = Math.max(1, state.viewport.cols - Array.from(TRANSCRIPT_INDENT).length);
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      const entry = state.transcript[i];
      if (entry.kind === "streaming") continue; // live turn is never collapsed
      if ((startLines[i] ?? 0) >= windowBottom) continue; // starts below the window
      const expandable = entry.tool
        ? toolOpHasDetail(entry.tool)
        : wrapText(entry.text, bodyWidth).length > TRANSCRIPT_PREVIEW_LINES;
      if (expandable) return i;
    }
    return -1;
  }

  // Toggle full-height display of the selected expandable block (the newest one on
  // screen) and recompute the scroll offset so that block's first line stays put —
  // opening/closing details never displaces the content being inspected
  // (Issue #163, criterion 4). A no-op when nothing is collapsible.
  function toggleExpandSelected(): void {
    const height = transcriptHeight();
    if (height <= 0) return;
    const cols = state.viewport.cols;
    const flatLenBefore = flattenedLen();
    const scrollBefore = clamp(state.scroll ?? 0, 0, Math.max(0, flatLenBefore - height));
    const windowBottom = flatLenBefore - scrollBefore;
    const beforeStarts = entryStartLines(state.transcript, cols, { expanded });
    const sel = selectedExpandableIndex(beforeStarts, windowBottom);
    if (sel < 0) return;
    const anchorBefore = beforeStarts[sel] ?? 0;
    if (expanded.has(sel)) expanded.delete(sel);
    else expanded.add(sel);
    const afterStarts = entryStartLines(state.transcript, cols, { expanded });
    const flatLenAfter = flattenedLen();
    const anchorAfter = afterStarts[sel] ?? 0;
    state.scroll = scrollToKeepAnchor({
      flatLenBefore,
      flatLenAfter,
      anchorBefore,
      anchorAfter,
      scrollBefore,
      height,
    });
    scheduleRender();
  }

  // Scroll the transcript window up (delta > 0) or down (delta < 0) by lines,
  // clamped to the scrollable range so the view never runs past either end.
  function scrollBy(delta: number): void {
    const height = transcriptHeight();
    if (height <= 0) return;
    const maxScroll = Math.max(0, flattenedLen() - height);
    state.scroll = clamp((state.scroll ?? 0) + delta, 0, maxScroll);
    scheduleRender();
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
      toolStart: ({ id, name, round, args }) => {
        if (!mine()) return;
        // The running tool is shown in place via the turn indicator AND as a
        // compact durable summary row (Issue #162). The row starts "running" and
        // is updated in place on toolResult, so each tool is one row rather than a
        // flood; attribution follows the agent round (criterion 4). The parsed
        // args are stashed so the result can derive a structured diff/failure
        // (Issue #163).
        state.turn = advanceTurn(state.turn, { type: "tool-start", name });
        runningTools.set(id, { index: state.transcript.length, start: Date.now(), args });
        state.transcript.push({
          kind: "tool",
          text: "",
          tool: { name, state: "running", turnId: round },
        });
        scheduleRender();
      },
      toolResult: ({ id, name, result, round }) => {
        if (!mine()) return;
        const tracked = runningTools.get(id);
        runningTools.delete(id);
        const durationMs = result.elapsedMs ?? (tracked ? Date.now() - tracked.start : undefined);
        // Preserve an approval-blocked verdict set at the prompt so a denial is
        // not relabeled as a generic failure (criterion 1).
        const prior = tracked ? state.transcript[tracked.index]?.tool : undefined;
        const finalState: ToolOpState =
          prior?.state === "approval-blocked"
            ? "approval-blocked"
            : result.isError
              ? "failed"
              : "succeeded";
        const op = makeToolOperation({
          name,
          state: finalState,
          turnId: round,
          input: prior?.input,
          output: (result.content ?? "").replace(/\s+$/, ""),
          durationMs,
        });
        // Derive structured inspection from the stashed args + result (Issue
        // #163): a successful file mutation yields a diff; any error yields a
        // cause/action/next-step summary. Both are bounded and sanitized.
        const args = tracked?.args ?? {};
        if (finalState === "succeeded") {
          const diff = deriveFileDiff(name, args);
          if (diff) op.diff = diff;
        }
        if (result.isError) {
          const failure = deriveFailure(name, args, result);
          if (failure) op.failure = failure;
        }
        const entry: TranscriptEntry = { kind: finalState === "succeeded" ? "tool" : "error", text: "", tool: op };
        if (tracked && state.transcript[tracked.index]?.tool) {
          // Update the running row in place so the tool stays one durable summary.
          state.transcript[tracked.index] = entry;
        } else {
          // No matching start (defensive): append the result as its own row.
          state.transcript.push(entry);
        }
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
        // Capture the requested arguments as the operation's sanitized input so
        // the durable summary can disclose what was asked (criterion 3). The
        // running row for this tool is the most recent running operation with the
        // same name; the agent is paused on this approval so the index stays valid.
        let approvalIndex = -1;
        for (let i = state.transcript.length - 1; i >= 0; i--) {
          const t = state.transcript[i].tool;
          if (t && t.state === "running" && t.name === name) {
            approvalIndex = i;
            break;
          }
        }
        if (approvalIndex >= 0) {
          let argsText: string;
          try {
            argsText = typeof args === "string" ? args : JSON.stringify(args);
          } catch {
            argsText = String(args);
          }
          const capped = argsText.length > 500 ? `${argsText.slice(0, 500)}…` : argsText;
          const prior = state.transcript[approvalIndex];
          if (prior.tool) {
            state.transcript[approvalIndex] = {
              ...prior,
              tool: { ...prior.tool, input: sanitizeToolText(capped) },
            };
          }
        }
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
          if (!approved && approvalIndex >= 0 && state.transcript[approvalIndex]?.tool) {
            // Mark the operation approval-blocked so its durable summary
            // distinguishes a denial from a runtime failure (criterion 1).
            const prior = state.transcript[approvalIndex];
            state.transcript[approvalIndex] = {
              ...prior,
              tool: { ...(prior.tool as ToolOperation), state: "approval-blocked" },
            };
          }
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
    // Busy, empty, and repeated submissions are explicit non-destructive no-ops
    // (criterion 3): while a turn is in flight the composer is not editable, so we
    // never queue a duplicate run; empty/whitespace input sends nothing.
    if (!submitAllowed(state.composer.mode, state.composer.text)) return;
    const text = state.composer.text.trim();
    const slash = text.startsWith("/attach")
      ? { kind: "prompt" as const }
      : resolveSlashCommand(
          text,
          opts.paletteCommands.map((command) => command.name),
        );
    if (slash.kind === "unknown") {
      state.composer.text = "";
      state.slashPreview = undefined;
      slashPreviewDismissedFor = null;
      history = commitDraft(history, "");
      refreshMode();
      state.transcript.push({ kind: "notice", text: slash.message });
      scheduleRender();
      return;
    }
    if (slash.kind === "command") {
      state.composer.text = "";
      state.slashPreview = undefined;
      slashPreviewDismissedFor = null;
      history = commitDraft(history, "");
      refreshMode();
      const command = opts.paletteCommands.find(
        (candidate) => candidate.name === slash.name,
      );
      if (command) void runPaletteCommand(command);
      else {
        state.transcript.push({
          kind: "notice",
          text: `Command unavailable: ${slash.name}`,
        });
        scheduleRender();
      }
      return;
    }
    if (text.startsWith("/attach")) {
      state.composer.text = "";
      state.slashPreview = undefined;
      slashPreviewDismissedFor = null;
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
    state.slashPreview = undefined;
    slashPreviewDismissedFor = null;
    state.composer.mode = "submitting";
    state.turn = advanceTurn(state.turn, { type: "submit" });
    state.transcript.push({ kind: "user", text });
    // A fresh prompt re-follows the conversation from the bottom.
    state.scroll = 0;
    // Record the prompt for future recall and reset navigation to a fresh draft;
    // the user has now exercised the send flow, so compress the footer hints.
    history = pushPromptHistory(history, text);
    state.hintsLearned = true;
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
    // The outcome is decided purely by turn phase and whether a draft exists
    // (criterion 4): interrupt active work, clear a draft, dismiss a finished
    // turn's lingering outcome, or exit. Clearing a draft also drops the saved
    // history draft so a later Up does not restore the cancelled text.
    switch (cancelDecision(state.turn, state.composer.text.length > 0)) {
      case "interrupt":
        // A turn is in flight: request cancellation. It settles to "cancelled"
        // once the in-flight provider call returns (it cannot be aborted
        // directly), so the indicator first reads "interrupting" then "cancelled".
        runGeneration++; // stop the in-flight run from contributing further
        // Mark any in-flight tool operations as cancelled so their durable
        // summaries reflect the interruption instead of hanging as "running".
        for (let i = 0; i < state.transcript.length; i++) {
          const e = state.transcript[i];
          if (e.tool && e.tool.state === "running") {
            state.transcript[i] = { ...e, tool: { ...e.tool, state: "cancelled" } };
          }
        }
        runningTools.clear();
        state.turn = advanceTurn(state.turn, { type: "interrupt" });
        state.composer.mode = "cancelled";
        scheduleRender();
        return;
      case "clear-draft":
        state.composer.text = "";
        state.slashPreview = undefined;
        slashPreviewDismissedFor = null;
        history = commitDraft(history, "");
        refreshMode();
        scheduleRender();
        return;
      case "dismiss-outcome":
        // Nothing is running to cancel (a finished turn's outcome is still shown):
        // acknowledge the rejected request and clear the indicator instead of exiting.
        state.transcript.push({ kind: "notice", text: "nothing to interrupt" });
        state.turn = { phase: "idle" };
        scheduleRender();
        return;
      case "exit":
        shutdown(0);
    }
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
      state.scroll = 0;
      scheduleRender();
      return;
    }
    if (cmd.name === "/help") {
      // Show the same in-place shortcut panel the `?` key toggles (Issue #169).
      openHelp();
      return;
    }
    const runtimeOutput = formatRuntimeSlashCommand(cmd.name, {
      model: opts.config.model,
      workspace: opts.workspace.root,
      approvalMode: opts.approvalMode,
      sessionId: opts.sessionId,
      settingsPath: opts.settingsPath,
      tools: opts.tools,
    });
    if (runtimeOutput !== null) {
      state.transcript.push({ kind: "notice", text: runtimeOutput });
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
    const incoming = buf.toString("utf-8");
    if (escapeBuffer || incoming.startsWith("\x1b")) {
      if (escapeTimer) clearTimeout(escapeTimer);
      escapeTimer = null;
      const decoded = decodeTerminalEscape(escapeBuffer, incoming);
      if (decoded.kind === "key") {
        escapeBuffer = "";
        handleData(Buffer.from(decoded.key));
        if (decoded.rest) onData(Buffer.from(decoded.rest));
        return;
      }
      if (decoded.kind === "wait") {
        escapeBuffer = decoded.pending;
        escapeTimer = setTimeout(() => {
          const pending = escapeBuffer;
          escapeBuffer = "";
          escapeTimer = null;
          if (pending) handleData(Buffer.from(pending));
        }, 25);
        return;
      }
      escapeBuffer = "";
      handleData(Buffer.from("\x1b"));
      if (decoded.rest) handleData(Buffer.from(decoded.rest));
      return;
    }
    handleData(buf);
  }

  function handleData(buf: Buffer): void {
    if (paletteOpen) return;
    const s = buf.toString("utf-8");

    // While the help panel is open it is modal: only the dismiss gestures act
    // (`?` again, Esc, or Ctrl+C); every other key is ignored so nothing is
    // typed behind the panel (Issue #169).
    if (state.helpOpen) {
      if (buf.length === 1) {
        const b = buf[0];
        if (b === 0x03 || b === 0x3f || b === 0x1b) return closeHelp();
      }
      return;
    }

    if (buf.length === 1) {
      const b = buf[0];
      if (b === 0x03) return onCtrlC(); // Ctrl+C
      if (b === 0x04) return shutdown(0); // Ctrl+D
      if (b === 0x1b && state.slashPreview) return dismissSlashPreview();
      if (b === 0x0b) {
        void openPalette();
        return;
      } // Ctrl+K
      if (b === 0x0c) {
        paint();
        return;
      } // Ctrl+L redraw
      if (b === 0x09) {
        if (state.slashPreview) return completeSlashSelection(false);
        return toggleExpandSelected();
      } // Tab: complete a slash command, otherwise expand/collapse transcript
      if (b === 0x7f || b === 0x08) return backspace();
      if (b === 0x0d || b === 0x0a) {
        if (state.slashPreview?.items.length) {
          completeSlashSelection(true);
          return;
        }
        submit();
        return;
      }
      // `?` on an empty composer toggles the help panel; with any text it inserts
      // the character as usual (Issue #169).
      if (b === 0x3f && questionMarkOpensHelp(state.composer.text)) return toggleHelp();
      if (b >= 0x20 && b < 0x7f) return insert(String.fromCharCode(b));
      return;
    }

    // Multiline insertion (Alt/Shift+Enter on common terminals).
    if (s === "\x1b\r" || s === "\x1b\n" || s === "\x1b\x0a") return insertNewline();
    // Prompt-history recall (criterion 2): Up/Down recall previous prompts in both
    // normal (\x1b[A/B) and application (\x1bOA/OB) cursor modes. This slice keeps
    // the caret at end-of-input, so recall never hijacks intra-text cursor movement.
    if (s === "\x1b[A" || s === "\x1bOA") {
      if (state.slashPreview) return moveSlashSelection(-1);
      return recallPrevious();
    }
    if (s === "\x1b[B" || s === "\x1bOB") {
      if (state.slashPreview) return moveSlashSelection(1);
      return recallNext();
    }
    // PageUp/PageDown scroll the transcript window without touching the composer,
    // so earlier diffs/failures can be inspected in context (Issue #163). PageUp
    // lifts the view up (toward older content); PageDown returns toward the newest.
    if (s === "\x1b[5~") return scrollBy(transcriptHeight());
    if (s === "\x1b[6~") return scrollBy(-transcriptHeight());
    // Left/Right and other cursor/edit sequences remain no-ops (caret stays at
    // end-of-input in this slice).
    if (
      s === "\x1b[C" ||
      s === "\x1b[D" ||
      s === "\x1bOC" ||
      s === "\x1bOD" ||
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
    // Re-anchor the transcript to the entry currently at the top of the window so a
    // resize reflows the same content in place instead of displacing it. The draft,
    // expanded blocks, active turn, and execution state all live in `state` and
    // survive untouched (Issue #164, criteria 2, 5).
    const oldCols = state.viewport.cols;
    const heightBefore = transcriptHeight();
    const scrollBefore = clamp(state.scroll ?? 0, 0, Math.max(0, flattenedLen() - heightBefore));
    state.viewport.rows = stdout.rows ?? state.viewport.rows;
    state.viewport.cols = stdout.columns ?? state.viewport.cols;
    state.scroll = resizeScrollOffset({
      entries: state.transcript,
      expanded,
      oldCols,
      newCols: state.viewport.cols,
      scrollBefore,
      heightBefore,
      heightAfter: transcriptHeight(),
    });
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
