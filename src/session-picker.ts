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
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import type { SessionSummary } from "./session-summary.js";
import type { SessionStore } from "./session.js";

// A session's resumability, derived from its checkpoint integrity and whether
// its declared workspace still exists. "stale" means the checkpoint is readable
// but the workspace it belongs to is gone, so resuming would land the user in
// the wrong place — that fails closed instead of silently using another.
export type SessionPickerState = "ok" | "partial" | "corrupt" | "stale";

export interface SessionPickerRow {
  id: string;
  // Short, stable display id (first uuid segment). Never transcript text.
  shortId: string;
  // Goal objective when present, else a neutral "Session <shortId>" label.
  // Redacted because a goal is user-authored text.
  title: string;
  workspace: string; // redacted, ~ collapsed, or "unknown"
  model: string; // redacted, or "unknown"
  ageLabel: string; // "5m ago"
  lastModified: number; // deterministic sort key
  state: SessionPickerState;
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
  return oneLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + "…";
}

function workspaceExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Project a stored summary plus its goal title into a redacted picker row.
// Pure: it never touches the filesystem, so rendering and redaction are
// testable in isolation.
export function projectSessionRow(
  summary: SessionSummary,
  opts: { title?: string; state: SessionPickerState },
): SessionPickerRow {
  const shortId = shortSessionId(summary.id);
  const goalTitle = opts.title?.trim();
  const title = goalTitle ? clampTitle(redactSecrets(goalTitle).text) : `Session ${shortId}`;
  return {
    id: summary.id,
    shortId,
    title,
    workspace: redactWorkspace(summary.workspace),
    model: redactModel(summary.model),
    ageLabel: formatSessionAge(summary.ageMs),
    lastModified: summary.lastModified,
    state: opts.state,
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
export function collectSessionPickerRows(
  store: SessionStore,
  opts: SessionPickerRowOptions = {},
): SessionPickerRow[] {
  const now = opts.now ?? (() => Date.now());
  const summaries = collectSessionSummaries(store, { now });
  const rows = summaries.map((summary) =>
    projectSessionRow(summary, {
      title: store.readGoal(summary.id).goal?.objective,
      state: classifyState(store, summary),
    }),
  );
  return orderSessionRows(rows);
}

// Most recently active first, with the id as a stable tiebreaker so the order
// is identical across restarts even when two sessions share a mtime.
export function orderSessionRows(rows: SessionPickerRow[]): SessionPickerRow[] {
  return [...rows].sort(
    (a, b) => b.lastModified - a.lastModified || a.id.localeCompare(b.id),
  );
}

// Case-insensitive substring match across the visible fields. Order is
// preserved so filtering stays deterministic.
export function filterSessionRows(rows: SessionPickerRow[], query: string): SessionPickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) =>
    [row.shortId, row.id, row.title, row.workspace, row.model]
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

export interface SessionPickerRenderState {
  query: string;
  selected: number;
  maxVisible?: number;
  error?: string | null;
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
    `${bold}Sessions${reset}  ${dim}↑↓ navigate · type to search · Enter resume · Esc cancel${reset}`,
  );
  lines.push(`  ${dim}> ${reset}${state.query}${clearLine}`);
  if (state.error) {
    lines.push(`  ${danger}${state.error}${reset}${clearLine}`);
  }
  lines.push("");

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
    const note = STATE_NOTE[row.state];
    const noteText = note ? `  ${dim}(${note})${reset}` : "";
    lines.push(`${marker}${isSelected ? bold : ""}${row.title}${reset}${noteText}${clearLine}`);
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
const CLEAR_LINE = `${ESC}2K`;
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
    const allRows = collectSessionPickerRows(store);
    let query = "";
    let selected = 0;
    let error: string | null = null;
    let rows = filterSessionRows(allRows, query);
    let renderedLines = 0;

    function render() {
      const lines = renderSessionPickerLines(rows, { query, selected, error }, style);
      const totalLines = lines.length;
      stdout.write(`${MOVE_UP(renderedLines)}${lines.join("\n")}\n`);
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
        render();
        return;
      }
      if (key === "\x1b[B" || key === "\x1bOB") {
        if (selected < rows.length - 1) selected++;
        error = null;
        render();
        return;
      }

      // Backspace.
      if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        rows = filterSessionRows(allRows, query);
        selected = 0;
        error = null;
        render();
        return;
      }

      // Printable character.
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
        query += key;
        rows = filterSessionRows(allRows, query);
        selected = 0;
        error = null;
        render();
        return;
      }
    }

    stdout.write(HIDE_CURSOR);
    render();
    stdin.setRawMode(true);
    stdin.on("data", onKey);
  });
}
