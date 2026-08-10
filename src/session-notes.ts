// Durable session notes (Issue #602).
//
// Session metadata covered identity (user-owned names, #249) and retirement
// (archive markers, #598) but had no place for durable commentary about a
// session — why it matters, what was decided, what to pick up next. Notes
// fill that gap as an append-only, bounded, redacted ledger in a sidecar.
//
// The sidecar follows the established conventions: a distinct extension
// outside listIds() (integrity-agnostic — corrupt sessions are annotatable,
// exactly like the name/archive markers), atomic temp+rename writes, secrets
// redacted BEFORE persistence (the --memory-add convention), bounded storage
// with a truthful dropped count (failure receipts), and a versioned
// read-only record for the view surface (goal-status / session-inspect).
// An unreadable sidecar is never overwritten — it is preserved and reported.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";

export const SESSION_NOTES_SCHEMA = "oh-my-cli.session-notes" as const;
export const SESSION_NOTES_VERSION = 1 as const;
/** The sidecar keeps only the newest N notes; overflow drops the oldest. */
export const SESSION_NOTES_MAX = 20;
/** Per-note text bound (chars), applied after sanitization. */
export const SESSION_NOTE_MAX_CHARS = 500;

export interface SessionNoteEntry {
  /** Epoch ms when the note was appended. */
  at: number;
  /** Sanitized, redacted note text (as persisted). */
  text: string;
}

interface PersistedNotes {
  schema: typeof SESSION_NOTES_SCHEMA;
  v: typeof SESSION_NOTES_VERSION;
  sessionId: string;
  /** Newest first. */
  notes: SessionNoteEntry[];
  /** Count of notes dropped by the bound (oldest first). */
  dropped: number;
}

export interface SessionNotesLoad {
  /** Newest first; empty when no sidecar exists. */
  notes: SessionNoteEntry[];
  dropped: number;
  /** True when a sidecar exists but cannot be parsed; it is preserved. */
  corrupt: boolean;
}

export interface AppendNoteOutcome {
  ok: boolean;
  reason?: string;
  /** Total notes now recorded. */
  recorded?: number;
  /** Notes dropped by the bound, if the bound tripped on this append. */
  droppedNow?: number;
}

export function notesPath(store: SessionStore, id: string): string {
  const fp = store.filePath(id);
  return fp.endsWith(".jsonl") ? fp.slice(0, -".jsonl".length) + ".notes.json" : fp + ".notes.json";
}

// Terminal-safe + secret-redaction pipeline (the goal-objective convention),
// bounded to SESSION_NOTE_MAX_CHARS. Returns "" for input that sanitizes to
// nothing.
function sanitizeNoteText(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= SESSION_NOTE_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, safeCutEnd(redacted, SESSION_NOTE_MAX_CHARS - 1))}…`;
}

export function readSessionNotes(store: SessionStore, id: string): SessionNotesLoad {
  let raw: string;
  try {
    raw = fs.readFileSync(notesPath(store, id), "utf8");
  } catch {
    return { notes: [], dropped: 0, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedNotes>;
    if (!Array.isArray(parsed.notes)) return { notes: [], dropped: 0, corrupt: true };
    const notes = parsed.notes.filter(
      (n): n is SessionNoteEntry =>
        typeof n === "object" &&
        n !== null &&
        typeof (n as SessionNoteEntry).at === "number" &&
        typeof (n as SessionNoteEntry).text === "string",
    );
    return {
      notes,
      dropped: typeof parsed.dropped === "number" ? parsed.dropped : 0,
      corrupt: false,
    };
  } catch {
    return { notes: [], dropped: 0, corrupt: true };
  }
}

// Append one note. Metadata-only and integrity-agnostic: the transcript and
// every other sidecar are untouched. An unreadable sidecar is never
// overwritten. Prior entries are preserved exactly (prepend + bound slice);
// only the oldest entries fall off once the bound trips.
export function appendSessionNote(
  store: SessionStore,
  id: string,
  text: string,
  now: number = Date.now(),
): AppendNoteOutcome {
  if (store.integrity(id).status === "missing") {
    return { ok: false, reason: `session ${shortSessionId(id)} was not found` };
  }
  const sanitized = sanitizeNoteText(text);
  if (sanitized === "") {
    return { ok: false, reason: "note is empty after sanitization" };
  }
  const load = readSessionNotes(store, id);
  if (load.corrupt) {
    return {
      ok: false,
      reason: "the notes sidecar is unreadable and is preserved; it cannot be appended",
    };
  }
  const notes = [{ at: now, text: sanitized }, ...load.notes];
  let dropped = load.dropped;
  let droppedNow = 0;
  if (notes.length > SESSION_NOTES_MAX) {
    droppedNow = notes.length - SESSION_NOTES_MAX;
    dropped += droppedNow;
  }
  const kept = notes.slice(0, SESSION_NOTES_MAX);
  const persisted: PersistedNotes = {
    schema: SESSION_NOTES_SCHEMA,
    v: SESSION_NOTES_VERSION,
    sessionId: id,
    notes: kept,
    dropped,
  };
  const target = notesPath(store, id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(persisted)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return { ok: true, recorded: kept.length, droppedNow };
}

// Versioned record for `--session-notes --output json` (Issue #602).
export interface SessionNotesRecord {
  schema: typeof SESSION_NOTES_SCHEMA;
  v: typeof SESSION_NOTES_VERSION;
  sessionId: string;
  /** Newest first, ISO timestamps. */
  notes: Array<{ at: string; text: string }>;
  dropped: number;
  /** True when a sidecar exists but is unreadable (preserved, not shown). */
  sidecarCorrupt: boolean;
}

export function buildSessionNotesRecord(store: SessionStore, id: string): SessionNotesRecord {
  const load = readSessionNotes(store, id);
  return {
    schema: SESSION_NOTES_SCHEMA,
    v: SESSION_NOTES_VERSION,
    sessionId: id,
    notes: load.notes.map((n) => ({ at: new Date(n.at).toISOString(), text: n.text })),
    dropped: load.dropped,
    sidecarCorrupt: load.corrupt,
  };
}

export function formatSessionNotes(record: SessionNotesRecord): string[] {
  const lines: string[] = [];
  lines.push(`Session notes — ${shortSessionId(record.sessionId)}`);
  lines.push("─".repeat(40));
  lines.push("");
  if (record.sidecarCorrupt) {
    lines.push("The notes sidecar is unreadable and is preserved; no notes can be shown.");
    return lines;
  }
  if (record.notes.length === 0) {
    lines.push("No notes recorded for this session.");
    return lines;
  }
  for (const n of record.notes) {
    lines.push(`  ${n.at} · ${n.text}`);
  }
  lines.push("");
  const dropped = record.dropped > 0 ? ` (+${record.dropped} older note(s) dropped by the bound)` : "";
  lines.push(`${record.notes.length} note(s).${dropped}`);
  return lines;
}
