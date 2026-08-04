// Read-only turn-change provenance view (Issue #568). Renders a session's
// durable turn-checkpoint log (src/turn-checkpoint.ts) as one bounded entry
// per turn: the captured head, the message-count delta, and the turn's file
// changes with derived actions and a bounded line-change magnitude — plus the
// undo state and the durable undo/redo receipts. Strictly read-only: it never
// writes the turn log, session store, or workspace, and it never echoes file
// content — only paths, actions, magnitudes, and receipt digests. Sibling
// conventions: #536 id-or-name resolution upstream, deterministic redacted
// output, versioned JSON record.

import { redactSecrets } from "./permission-impact.js";
import { loadTurnLog, turnLogExists } from "./turn-checkpoint.js";
import type { SessionStore } from "./session.js";
import type { TurnCheckpoint, TurnLog } from "./turn-checkpoint.js";
import { shortSessionId } from "./session-picker.js";

export const TURN_HISTORY_SCHEMA = "oh-my-cli.turn-history" as const;
export const TURN_HISTORY_VERSION = 1 as const;

// Bounds so a huge turn cannot flood the view (overflow is counted, never
// silently dropped).
export const MAX_HISTORY_FILES_PER_TURN = 50;
// Content beyond this many lines is clipped before the magnitude computation.
const MAX_MAGNITUDE_LINES = 1_000;

export type TurnFileAction = "created" | "modified" | "deleted";

export interface TurnFileChange {
  path: string;
  action: TurnFileAction;
  // Line-change magnitude: added/removed line counts for created/modified/
  // deleted respectively. Order-independent (frequency-based), never a hunk
  // diff, and never file content.
  added: number;
  removed: number;
}

export interface TurnHistoryEntry {
  turnIndex: number;
  /** Git HEAD at capture, or null when the workspace was not a Git repo. */
  head: string | null;
  messagesBefore: number;
  messagesAfter: number;
  /** sha256 receipt digest of the canonical checkpoint. */
  digest: string;
  files: TurnFileChange[];
  /** Count of further file changes omitted at the bound (0 when none). */
  omittedFiles: number;
}

export type TurnLogState = "ok" | "empty" | "none";

export interface TurnHistoryRecord {
  schema: typeof TURN_HISTORY_SCHEMA;
  v: typeof TURN_HISTORY_VERSION;
  sessionId: string;
  // "none": no turn log file; "empty": a turn log exists but has no readable
  // checkpoints; "ok": checkpoints rendered. Never fabricates turns.
  logState: TurnLogState;
  undoneTurnIndex: number | null;
  entries: TurnHistoryEntry[];
  receipts: Array<{ turnIndex: number; op: "undo" | "redo"; digest: string; at: string }>;
}

// Derive one file's change from its before/after images, or null when the
// turn left it untouched (identical content hashes).
export function deriveFileChange(file: {
  path: string;
  before: { exists: boolean; sha256: string | null; content: string | null };
  after: { exists: boolean; sha256: string | null; content: string | null };
}): TurnFileChange | null {
  const { path, before, after } = file;
  if (!before.exists && !after.exists) return null;
  if (!before.exists && after.exists) {
    return { path, action: "created", added: lineCount(after.content), removed: 0 };
  }
  if (before.exists && !after.exists) {
    return { path, action: "deleted", added: 0, removed: lineCount(before.content) };
  }
  if (before.sha256 === after.sha256) return null; // untouched
  const diff = lineMagnitude(before.content, after.content);
  return { path, action: "modified", added: diff.added, removed: diff.removed };
}

// Build the full read-only record for a session (Issue #568). Never mutates.
export function buildTurnHistory(opts: { sessionId: string; store: SessionStore }): TurnHistoryRecord {
  const { sessionId, store } = opts;
  const exists = turnLogExists(store, sessionId);
  const log: TurnLog = loadTurnLog(store, sessionId);
  const logState: TurnLogState = !exists ? "none" : log.checkpoints.length === 0 ? "empty" : "ok";
  return {
    schema: TURN_HISTORY_SCHEMA,
    v: TURN_HISTORY_VERSION,
    sessionId,
    logState,
    undoneTurnIndex: log.undoneTurnIndex,
    entries: log.checkpoints.map(checkpointEntry),
    receipts: log.receipts.map((r) => ({
      turnIndex: r.turnIndex,
      op: r.op,
      digest: r.digest,
      at: r.at,
    })),
  };
}

function checkpointEntry(checkpoint: TurnCheckpoint): TurnHistoryEntry {
  const changes: TurnFileChange[] = [];
  let omitted = 0;
  for (const file of checkpoint.files) {
    const change = deriveFileChange(file);
    if (change === null) continue;
    if (changes.length >= MAX_HISTORY_FILES_PER_TURN) {
      omitted++;
      continue;
    }
    changes.push(change);
  }
  return {
    turnIndex: checkpoint.turnIndex,
    head: checkpoint.head,
    messagesBefore: checkpoint.messageCountBefore,
    messagesAfter: checkpoint.messageCountAfter,
    digest: checkpoint.digest,
    files: changes,
    omittedFiles: omitted,
  };
}

// Deterministic text rendering (no ANSI): one bounded block per turn plus the
// undo state and receipts. Content is never included — provenance only.
export function formatTurnHistory(record: TurnHistoryRecord): string[] {
  const short = shortSessionId(record.sessionId);
  const lines: string[] = [];
  lines.push(`Turn history — session ${short}`);
  lines.push("─".repeat(40));

  if (record.logState === "none") {
    lines.push("");
    lines.push("No turn checkpoints recorded for this session.");
    return lines;
  }
  if (record.logState === "empty" || record.entries.length === 0) {
    lines.push("");
    lines.push("A turn log exists but has no readable checkpoints.");
    return lines;
  }

  lines.push("");
  for (const entry of record.entries) {
    const head = entry.head === null ? "no git head" : `head ${entry.head.slice(0, 12)}`;
    lines.push(
      `Turn ${entry.turnIndex} · ${head} · messages ${entry.messagesBefore} → ${entry.messagesAfter} · digest ${entry.digest.slice(0, 12)}`,
    );
    if (entry.files.length === 0 && entry.omittedFiles === 0) {
      lines.push("  (no file changes)");
    }
    for (const file of entry.files) {
      lines.push(`  ${formatFileChange(file)}`);
    }
    if (entry.omittedFiles > 0) {
      lines.push(`  … ${entry.omittedFiles} more file change(s) not shown`);
    }
  }

  lines.push("");
  lines.push(
    record.undoneTurnIndex === null
      ? "Undo state: none"
      : `Undo state: turn ${record.undoneTurnIndex} undone (its pre-image is on disk)`,
  );
  if (record.receipts.length === 0) {
    lines.push("Receipts: none");
  } else {
    for (const r of record.receipts) {
      lines.push(`Receipt: turn ${r.turnIndex} ${r.op} · digest ${r.digest.slice(0, 12)} · at ${safeText(r.at)}`);
    }
  }
  return lines;
}

function formatFileChange(file: TurnFileChange): string {
  const path = safeText(file.path);
  if (file.action === "created") return `[created]  ${path} (+${file.added} lines)`;
  if (file.action === "deleted") return `[deleted]  ${path} (-${file.removed} lines)`;
  return `[modified] ${path} (+${file.added} -${file.removed} lines)`;
}

function lineCount(content: string | null): number {
  if (content === null || content === "") return 0;
  const lines = content.split("\n");
  // A trailing newline does not start an extra line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return Math.min(lines.length, MAX_MAGNITUDE_LINES);
}

// Order-independent line-change magnitude (frequency difference), bounded by
// MAX_MAGNITUDE_LINES on each side. A magnitude indicator, not a hunk diff.
function lineMagnitude(before: string | null, after: string | null): { added: number; removed: number } {
  const beforeLines = boundedLines(before);
  const afterLines = boundedLines(after);
  const freq = new Map<string, number>();
  for (const line of beforeLines) freq.set(line, (freq.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of afterLines) {
    const n = freq.get(line) ?? 0;
    if (n > 0) freq.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of freq.values()) removed += n;
  return { added, removed };
}

function boundedLines(content: string | null): string[] {
  if (content === null || content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, MAX_MAGNITUDE_LINES);
}

function safeText(value: string): string {
  return redactSecrets(value).text;
}
