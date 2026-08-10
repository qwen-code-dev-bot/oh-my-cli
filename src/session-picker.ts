// Interactive session browser (Issue #197).
//
// Before this picker a user had to leave the conversation, run --list-sessions,
// copy a session id by hand, and restart with --resume <id>. This module
// enumerates the session store read-only into deterministic, redacted rows and
// resolves an exact resume target with fail-closed semantics: a missing,
// corrupt, or stale-workspace session is reported with an actionable reason
// instead of silently resuming something else. The projection/filter/order/
// render functions are pure and unit-testable without a TTY; runSessionPicker
// is the thin raw-mode driver modeled on runPalette.

import fs from "node:fs";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import type { SessionSummary } from "./session-summary.js";
import { sessionDisplayTitle } from "./session-name.js";
import type { SessionStore } from "./session.js";
import { workspaceTrustKey } from "./folder-trust.js";

// A session's resumability, derived from its checkpoint integrity and whether
// its declared workspace still exists. "stale" means the checkpoint is readable
// but the workspace it belongs to is gone, so resuming would land the user in
// the wrong place — that fails closed instead of silently using another.
export type SessionPickerState = "ok" | "partial" | "corrupt" | "stale";

export interface SessionPickerRow {
  id: string;
  // Short, stable display id (first uuid segment). Never transcript text.
  shortId: string;
  // The user-owned name (#249), redacted; undefined when none is set. Carried
  // separately from `title` so search matches the full name even when the display
  // title is clamped.
  name?: string;
  // Display title: explicit name, else goal objective, else a neutral
  // "Session <shortId>" label. Redacted because both name and goal are
  // user-authored text.
  title: string;
  workspace: string; // redacted, ~ collapsed, or "unknown"
  model: string; // redacted, or "unknown"
  ageLabel: string; // "5m ago"
  lastModified: number; // deterministic sort key
  state: SessionPickerState;
  /** True when the session is pinned (listed first, Issue #610/#612). */
  pinned?: boolean;
}

export interface SessionPickerRowOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const SHORT_ID_LENGTH = 8;
const TITLE_MAX_LENGTH = 60;

export function shortSessionId(id: string): string {
  const segment = id.split("-")[0] || id;
  return segment.slice(0, SHORT_ID_LENGTH);
}

function redactWorkspace(p: string | undefined): string {
  if (!p) return "unknown";
  return redactSecrets(redactHomePath(p)).text;
}

function redactModel(value: string | undefined): string {
  if (!value) return "unknown";
  return redactSecrets(value).text;
}

function clampTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_LENGTH) return oneLine;
  return oneLine.slice(0, safeCutEnd(oneLine, TITLE_MAX_LENGTH - 1)).trimEnd() + "…";
}

function workspaceExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Project a stored summary plus its goal title and user-owned name into a
// redacted picker row. Pure: it never touches the filesystem, so rendering and
// redaction are testable in isolation.
export function projectSessionRow(
  summary: SessionSummary,
  opts: { name?: string | null; title?: string; state: SessionPickerState },
): SessionPickerRow {
  const shortId = shortSessionId(summary.id);
  const name = opts.name && opts.name.trim() ? redactSecrets(opts.name).text : null;
  const goalTitle = opts.title && opts.title.trim() ? redactSecrets(opts.title).text : null;
  const title = clampTitle(sessionDisplayTitle({ name, goalTitle, shortId }));
  return {
    id: summary.id,
    shortId,
    name: name ?? undefined,
    title,
    workspace: redactWorkspace(summary.workspace),
    model: redactModel(summary.model),
    ageLabel: formatSessionAge(summary.ageMs),
    lastModified: summary.lastModified,
    state: opts.state,
    ...(summary.pinned ? { pinned: true } : {}),
  };
}

function classifyState(store: SessionStore, summary: SessionSummary): SessionPickerState {
  const status = store.integrity(summary.id).status;
  if (status === "corrupt" || status === "missing") return "corrupt";
  // Checkpoint is readable: fail closed if the declared workspace is gone.
  if (summary.workspace && !workspaceExists(summary.workspace)) return "stale";
  return status === "partial" ? "partial" : "ok";
}

// Enumerate the store into ordered, redacted rows. Reads each session's
// integrity and goal so the picker can flag corrupt/stale entries up front.
// Archived sessions (Issue #598) are retired from discovery and never
// offered; they remain resumable by exact id or name.
export function collectSessionPickerRows(
  store: SessionStore,
  opts: SessionPickerRowOptions = {},
): SessionPickerRow[] {
  const now = opts.now ?? (() => Date.now());
  const summaries = collectSessionSummaries(store, { now });
  const rows = summaries
    .filter((summary) => !summary.archived)
    .map((summary) =>
      projectSessionRow(summary, {
        name: store.readName(summary.id),
        title: store.readGoal(summary.id).goal?.objective,
        state: classifyState(store, summary),
      }),
    );
  return orderSessionRows(rows);
}

// Toggle a session's pin marker (Issue #620): the exact --pin-session /
// --unpin-session semantics on the same marker — pinned → marker removed,
// unpinned → marker written with a fresh timestamp. Metadata-only: nothing
// else in the store is touched. Returns the outcome so a caller can confirm
// or surface a failure; a write error is caught and reported, never thrown.
export interface ToggleSessionPinResult {
  ok: boolean;
  /** The new pin state when ok. */
  pinned?: boolean;
  reason?: string;
}

export function toggleSessionPin(
  store: SessionStore,
  id: string,
  now: number = Date.now(),
): ToggleSessionPinResult {
  try {
    if (store.readPinned(id) !== null) {
      store.clearPinned(id);
      return { ok: true, pinned: false };
    }
    store.writePinned(id, now);
    return { ok: true, pinned: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

// Pinned sessions first (Issue #612, completing #610's discovery story),
// then most recently active, with the id as a stable tiebreaker so the order
// is identical across restarts even when two sessions share a mtime.
export function orderSessionRows(rows: SessionPickerRow[]): SessionPickerRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true) ||
      b.lastModified - a.lastModified ||
      a.id.localeCompare(b.id),
  );
}

// Case-insensitive substring match across the visible fields, including the
// user-owned name (#249). Order is preserved so filtering stays deterministic
// and stable recency ordering is unchanged.
export function filterSessionRows(rows: SessionPickerRow[], query: string): SessionPickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) =>
    [row.shortId, row.id, row.name ?? "", row.title, row.workspace, row.model]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

export interface ResumeTarget {
  ok: boolean;
  sessionId: string;
  workspace?: string;
  reason?: string;
}

// Resolve the exact session to resume, fail-closed. The id must match a
// readable checkpoint whose declared workspace still exists; otherwise an
// actionable reason is returned and nothing is resumed. Never substitutes a
// different session or workspace.
export function resolveResumeTarget(id: string, store: SessionStore): ResumeTarget {
  const target = id.trim();
  if (!target) {
    return { ok: false, sessionId: id, reason: "no session id was provided" };
  }
  const shortId = shortSessionId(target);
  const status = store.integrity(target).status;
  if (status === "missing") {
    return { ok: false, sessionId: target, reason: `session ${shortId} was not found` };
  }
  if (status === "corrupt") {
    return {
      ok: false,
      sessionId: target,
      reason: `session ${shortId} is corrupt and cannot be resumed safely`,
    };
  }
  const workspace = store.readMeta(target)?.workspace;
  if (workspace && !workspaceExists(workspace)) {
    return {
      ok: false,
      sessionId: target,
      reason: `its workspace ${redactWorkspace(workspace)} no longer exists`,
    };
  }
  return { ok: true, sessionId: target, workspace };
}

// Resolve a command-line `--resume <id>` target fail-closed. Unlike the picker
// path (which validates a checkpoint that was just listed and restores its
// declared workspace), a flag-provided id resumes into the caller's workspace;
// the workspace binding is enforced by the caller once the target resolves
// (Issue #554). Heal the target checkpoint first (idempotent, scoped to this
// session alone) so a complete temp left by an interrupted write is promoted
// rather than misreported as missing, then fail closed when the id is empty,
// the session is missing, or the checkpoint cannot be resumed safely. A corrupt
// checkpoint is reported as corrupt even though healing quarantined it aside.
// Never substitutes a different session.
export function resolveResumeFlagTarget(id: string, store: SessionStore): ResumeTarget {
  const target = id.trim();
  if (!target) {
    return { ok: false, sessionId: id, reason: "no session id was provided" };
  }
  const recovery = store.recover(target);
  if (recovery.action === "quarantined") {
    return {
      ok: false,
      sessionId: target,
      reason: `session ${shortSessionId(target)} is corrupt and cannot be resumed safely`,
    };
  }
  const status = store.integrity(target).status;
  if (status === "missing") {
    return {
      ok: false,
      sessionId: target,
      reason: `session ${shortSessionId(target)} was not found`,
    };
  }
  if (status === "corrupt") {
    return {
      ok: false,
      sessionId: target,
      reason: `session ${shortSessionId(target)} is corrupt and cannot be resumed safely`,
    };
  }
  const workspace = store.readMeta(target)?.workspace;
  return { ok: true, sessionId: target, workspace };
}

// Resolve a user-owned session name (#534) to a resume target, fail-closed.
// Names are the identifying metadata users set with --rename-session precisely
// to find a session again; this makes --resume accept them. Exact match only
// (names are already validated: trimmed, bounded, no secret-like content).
// Ambiguous matches fail closed listing the short ids; matches that are
// corrupt are skipped, and when only corrupt sessions match the corrupt reason
// is reported. Never substitutes a different session.
export function resolveResumeByName(name: string, store: SessionStore): ResumeTarget {
  const target = name.trim();
  const display = redactSecrets(target).text;
  if (!target) {
    return { ok: false, sessionId: name, reason: `no session named "${display}" was found` };
  }
  const healthy: string[] = [];
  const corrupt: string[] = [];
  for (const id of store.listIds()) {
    const stored = store.readName(id);
    if (stored === null || stored.trim() !== target) continue;
    const status = store.integrity(id).status;
    if (status === "corrupt" || status === "missing") corrupt.push(id);
    else healthy.push(id);
  }
  if (healthy.length === 0) {
    if (corrupt.length > 0) {
      return {
        ok: false,
        sessionId: name,
        reason: `the session${corrupt.length > 1 ? "s" : ""} named "${display}" ${
          corrupt.length > 1 ? "are" : "is"
        } corrupt and cannot be resumed safely`,
      };
    }
    return { ok: false, sessionId: name, reason: `no session named "${display}" was found` };
  }
  if (healthy.length > 1) {
    const shorts = healthy.map((id) => shortSessionId(id)).join(", ");
    return {
      ok: false,
      sessionId: name,
      reason: `${healthy.length} sessions are named "${display}"; resume by exact session id (${shorts})`,
    };
  }
  const sessionId = healthy[0];
  const workspace = store.readMeta(sessionId)?.workspace;
  return { ok: true, sessionId, workspace };
}

// Resolve a session-targeted flag value (Issue #536): exact session id first
// (the pre-existing semantics, unchanged), then the user-owned name fallback
// (#534), then an unambiguous id-prefix tier (Issue #771). Every
// session-targeted flag shares this one contract — names are first-class
// across all surfaces. Fail-closed; never substitutes a different session.
export function resolveSessionTarget(value: string, store: SessionStore): ResumeTarget {
  const target = resolveResumeFlagTarget(value, store);
  if (target.ok) return target;
  const named = resolveResumeByName(value, store);
  if (named.ok) return named;
  // Id-prefix tier (Issue #771): the product displays 8-char short ids and
  // tells users to feed them back (the archive flow's restore hint, stale
  // reports, search matches), so a prefix that matches exactly one healthy
  // session resolves to it. Ambiguity fails closed listing the candidates;
  // corrupt/missing matches are skipped exactly like the name tier; no match
  // keeps the honest not-found reason above.
  const display = redactSecrets(value.trim()).text;
  const healthy: string[] = [];
  const corrupt: string[] = [];
  for (const id of sessionIdsWithPrefix(value, store)) {
    const status = store.integrity(id).status;
    if (status === "corrupt" || status === "missing") corrupt.push(id);
    else healthy.push(id);
  }
  if (healthy.length === 1) {
    const sessionId = healthy[0];
    const workspace = store.readMeta(sessionId)?.workspace;
    return { ok: true, sessionId, workspace };
  }
  if (healthy.length > 1) {
    const shorts = healthy.map((id) => shortSessionId(id)).join(", ");
    return {
      ok: false,
      sessionId: value,
      reason: `${healthy.length} sessions match the id prefix "${display}"; use the exact session id (${shorts})`,
    };
  }
  if (corrupt.length > 0) {
    return {
      ok: false,
      sessionId: value,
      reason: `the session${corrupt.length > 1 ? "s" : ""} matching "${display}" ${
        corrupt.length > 1 ? "are" : "is"
      } corrupt and cannot be resumed safely`,
    };
  }
  return named;
}

// Session ids that begin with the given prefix (Issue #771),
// case-insensitively — ids are lowercase UUIDs and surfaces display the
// 8-char short form. Returns every match; health/corrupt classification is
// the caller's, because the resolvers legitimately differ on whether corrupt
// sessions are valid targets (resume: no; archive: yes).
export function sessionIdsWithPrefix(prefix: string, store: SessionStore): string[] {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return [];
  const matches: string[] = [];
  for (const id of store.listIds()) {
    if (id.toLowerCase().startsWith(needle)) matches.push(id);
  }
  return matches;
}

// Workspace-binding verdict for a resolved `--resume` target (Issue #554).
// "match": the session's declared workspace collapses to the same canonical
// identity as the current one (the same comparison --continue uses, so symlink
// aliases and linked git worktrees of one repository still match). "legacy":
// the session predates workspace metadata, so there is nothing to compare —
// resuming warns but is not blocked. "mismatch": a different workspace, or an
// identity that cannot be canonicalized (fail closed rather than resume into
// an unverifiable workspace).
export type ResumeWorkspaceVerdict =
  | { verdict: "match" }
  | { verdict: "legacy" }
  | { verdict: "mismatch"; sessionWorkspace: string };

export function checkResumeWorkspaceBinding(
  sessionWorkspace: string | undefined,
  currentWorkspace: string,
  keyOf: (workspacePath: string) => string = workspaceTrustKey,
): ResumeWorkspaceVerdict {
  if (!sessionWorkspace) return { verdict: "legacy" };
  let sessionKey: string;
  let currentKey: string;
  try {
    sessionKey = keyOf(sessionWorkspace);
    currentKey = keyOf(currentWorkspace);
  } catch {
    return { verdict: "mismatch", sessionWorkspace };
  }
  return sessionKey === currentKey
    ? { verdict: "match" }
    : { verdict: "mismatch", sessionWorkspace };
}

// Bounded, redacted refusal for a foreign-workspace resume (#554): names the
// cause and at least one safe next action. Read-only inspection stays
// available from anywhere.
export function resumeWorkspaceMismatchMessage(
  sessionId: string,
  sessionWorkspace: string,
  currentWorkspace: string,
): string {
  return (
    `Cannot resume: session ${shortSessionId(sessionId)} belongs to workspace ` +
    `${redactWorkspace(sessionWorkspace)}, not the current workspace ` +
    `${redactWorkspace(currentWorkspace)}. Resume it from its own workspace, or inspect ` +
    `it anywhere with --export-session ${shortSessionId(sessionId)} or --session-stats ` +
    `${shortSessionId(sessionId)}.\n`
  );
}

// Bounded warning for a legacy session with no recorded workspace (#554):
// never silently, never blocked.
export function resumeWorkspaceLegacyMessage(sessionId: string): string {
  return (
    `Warning: session ${shortSessionId(sessionId)} has no recorded workspace; ` +
    `resuming without a workspace binding check.\n`
  );
}

export interface SessionPickerRenderState {
  query: string;
  selected: number;
  maxVisible?: number;
  error?: string | null;
  /** Brief confirmation line (e.g. a pin toggle), rendered until displaced. */
  note?: string | null;
}

export interface SessionPickerStyle {
  bold: string;
  dim: string;
  reset: string;
  clearLine: string;
  danger?: string;
}

const STATE_SYMBOL: Record<SessionPickerState, string> = {
  ok: "✓",
  partial: "✓",
  corrupt: "✗",
  stale: "✗",
};

const STATE_NOTE: Record<SessionPickerState, string> = {
  ok: "",
  partial: "partial",
  corrupt: "corrupt",
  stale: "workspace missing",
};

// Pure renderer for the picker body, extracted so color suppression and layout
// are unit-testable without a TTY. The selection marker (◆) is a literal glyph,
// not an ANSI code, so it survives NO_COLOR.
export function renderSessionPickerLines(
  rows: SessionPickerRow[],
  state: SessionPickerRenderState,
  style: SessionPickerStyle,
): string[] {
  const { bold, dim, reset, clearLine } = style;
  const danger = style.danger ?? "";
  const maxVisible = state.maxVisible ?? 8;
  const lines: string[] = [];
  lines.push(
    `${bold}Sessions${reset}  ${dim}↑↓ navigate · type to search · Ctrl-P pin · Enter resume · Esc cancel${reset}`,
  );
  lines.push(`  ${dim}> ${reset}${state.query}${clearLine}`);
  if (state.error) {
    lines.push(`  ${danger}${state.error}${reset}${clearLine}`);
  } else if (state.note) {
    lines.push(`  ${dim}${state.note}${reset}${clearLine}`);
  }
  // The blank separator still carries the clear suffix: re-renders can place
  // it over previously non-blank content (a toggle note shifts every line),
  // and a bare "" would leave that stale content visible (Issue #620).
  lines.push(clearLine);

  if (rows.length === 0) {
    lines.push(`  ${dim}${state.query ? "No matching sessions" : "No resumable sessions"}${reset}`);
    return lines;
  }

  const start = Math.max(0, state.selected - maxVisible + 1);
  const end = Math.min(rows.length, start + maxVisible);
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const isSelected = i === state.selected;
    const marker = isSelected ? `${bold}◆ ` : "  ";
    // Pinned rows carry a visible flag so the elevation is never invisible
    // (Issue #612); the pinned-first position comes from orderSessionRows.
    const pinnedText = row.pinned ? `  ${dim}(pinned)${reset}` : "";
    const note = STATE_NOTE[row.state];
    const noteText = note ? `  ${dim}(${note})${reset}` : "";
    lines.push(`${marker}${isSelected ? bold : ""}${row.title}${reset}${pinnedText}${noteText}${clearLine}`);
    const meta =
      `${STATE_SYMBOL[row.state]} ${row.shortId}  ·  ` +
      `${row.workspace}  ·  ${row.model}  ·  ${row.ageLabel}`;
    lines.push(`      ${dim}${meta}${reset}${clearLine}`);
  }
  if (rows.length > maxVisible) {
    lines.push(`  ${dim}… and ${rows.length - maxVisible} more${reset}`);
  }
  return lines;
}

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
// Erase-to-end-of-line (mode 0), NOT erase-entire-line (2K): the suffix is
// appended after each rendered line's content, so it must clear stale
// leftovers from a previously longer render without erasing the content just
// written. A 2K suffix self-erases the line it follows (discovered in the
// #612 E2E: every content line vanished, leaving only the header).
const CLEAR_LINE = `${ESC}K`;
const MOVE_UP = (n: number) => `${ESC}${n}A`;

export interface SessionPickerSelection {
  sessionId: string;
  workspace?: string;
}

// Standalone raw-mode picker over the session store, modeled on runPalette.
// Resolves the exact resume target on Enter (fail-closed: a corrupt or stale
// selection shows an actionable reason and keeps the picker open) and null on
// Esc/Ctrl+C. The current session and draft are never touched here.
export async function runSessionPicker(
  store: SessionStore,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  opts: { color?: boolean } = {},
): Promise<SessionPickerSelection | null> {
  return new Promise((resolve) => {
    const color = opts.color ?? true;
    const style: SessionPickerStyle = {
      bold: color ? `${ESC}1m` : "",
      dim: color ? `${ESC}2m` : "",
      reset: color ? `${ESC}0m` : "",
      danger: color ? `${ESC}31m` : "",
      clearLine: CLEAR_LINE,
    };
    let allRows = collectSessionPickerRows(store);
    let query = "";
    let selected = 0;
    let error: string | null = null;
    let note: string | null = null;
    let rows = filterSessionRows(allRows, query);
    let renderedLines = 0;

    function render() {
      const lines = renderSessionPickerLines(rows, { query, selected, error, note }, style);
      const totalLines = lines.length;
      stdout.write(`${MOVE_UP(renderedLines)}${lines.join("\n")}\n`);
      // When the block shrinks (the query filter narrows the rows), clear the
      // leftover lines from the previous taller render so no ghost content
      // lingers below the new block; park the cursor just under the block,
      // where a full-height render would leave it.
      if (totalLines < renderedLines) {
        const leftover = renderedLines - totalLines;
        for (let i = 0; i < leftover; i++) {
          stdout.write(`${CLEAR_LINE}\n`);
        }
        stdout.write(MOVE_UP(leftover));
      }
      renderedLines = totalLines;
    }

    function cleanup() {
      stdout.write(SHOW_CURSOR);
      stdout.write(`${MOVE_UP(renderedLines)}${CLEAR_LINE}`);
      for (let i = 1; i < renderedLines; i++) {
        stdout.write(`${MOVE_UP(1)}${CLEAR_LINE}`);
      }
    }

    function finish(selection: SessionPickerSelection | null) {
      cleanup();
      stdin.setRawMode(false);
      stdin.removeListener("data", onKey);
      resolve(selection);
    }

    function onKey(data: Buffer) {
      const key = data.toString();

      // Esc or Ctrl+C: cancel without resuming.
      if (key === "\x1b" || key === "\x03") {
        finish(null);
        return;
      }

      // Enter: resolve the exact selected session, fail-closed.
      if (key === "\r" || key === "\n") {
        if (rows.length === 0 || selected >= rows.length) {
          finish(null);
          return;
        }
        const target = resolveResumeTarget(rows[selected].id, store);
        if (target.ok) {
          finish({ sessionId: target.sessionId, workspace: target.workspace });
        } else {
          error = `Cannot resume: ${target.reason}`;
          render();
        }
        return;
      }

      // Arrow up / down.
      if (key === "\x1b[A" || key === "\x1bOA") {
        if (selected > 0) selected--;
        error = null;
        note = null;
        render();
        return;
      }
      if (key === "\x1b[B" || key === "\x1bOB") {
        if (selected < rows.length - 1) selected++;
        error = null;
        note = null;
        render();
        return;
      }

      // Ctrl-P: toggle the pin on the highlighted row (Issue #620). The
      // control chord keeps plain characters free for search queries. The
      // marker write uses the exact --pin-session/--unpin-session semantics;
      // a failure shows an actionable error and keeps the picker open.
      if (key === "\x10") {
        if (rows.length === 0 || selected >= rows.length) return;
        const row = rows[selected];
        const result = toggleSessionPin(store, row.id);
        if (!result.ok) {
          error = `Cannot toggle pin: ${result.reason}`;
          note = null;
          render();
          return;
        }
        // Re-enumerate so the row re-sorts into (or out of) the pinned
        // block, then follow the toggled row under the active query.
        allRows = collectSessionPickerRows(store);
        rows = filterSessionRows(allRows, query);
        const idx = rows.findIndex((r) => r.id === row.id);
        selected = idx >= 0 ? idx : 0;
        error = null;
        note = `${result.pinned ? "Pinned" : "Unpinned"} ${row.shortId}`;
        render();
        return;
      }

      // Backspace and printable characters. Fast typing and terminal pastes
      // arrive as multi-character chunks, so process every character of the
      // chunk rather than dropping all but single-key events (discovered in
      // the #612 E2E: a string sent in one chunk never reached the query).
      let changed = false;
      for (const ch of key) {
        if (ch === "\x7f" || ch === "\b") {
          query = query.slice(0, -1);
          changed = true;
        } else if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127) {
          query += ch;
          changed = true;
        }
      }
      if (changed) {
        rows = filterSessionRows(allRows, query);
        selected = 0;
        error = null;
        note = null;
        render();
      }
    }

    stdout.write(HIDE_CURSOR);
    render();
    stdin.setRawMode(true);
    stdin.on("data", onKey);
  });
}
