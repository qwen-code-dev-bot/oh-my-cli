// Per-session durable event journal (Issue #618).
//
// The durable-state surfaces render one facet at a time (goal status, notes,
// inspect card); nothing answers "how did this session get here?" in one
// chronological view. This module assembles a read-only journal from state
// that already carries timestamps: session creation (meta), goal transition
// history, notes, and the pin/archive markers, plus a last-activity entry
// from the transcript mtime.
//
// Guarantees follow the read-only family conventions: heal-free resolution
// at the call site (corrupt transcripts are still journalable — markers and
// readable history appear), redaction on every free-form value, honest
// absence for unreadable sidecars (a corrupt goal or notes sidecar
// contributes nothing, never guesses), deterministic ordering, and zero
// mutation of the store.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";
import { goalHistoryForDisplay } from "./session-goal.js";
import { readSessionNotes } from "./session-notes.js";

export const SESSION_JOURNAL_SCHEMA = "oh-my-cli.session-journal" as const;
export const SESSION_JOURNAL_VERSION = 1 as const;

/** The closed entry-kind taxonomy shared by both journal surfaces (#632). */
export const JOURNAL_KINDS = [
  "created",
  "goal",
  "note",
  "pinned",
  "archived",
  "last-activity",
] as const;

export type SessionJournalKind = (typeof JOURNAL_KINDS)[number];

/**
 * Filter journal entries by kind (Issue #632). Undefined or an empty set
 * means "no filter" (all entries, order preserved); otherwise only entries
 * whose kind is in the set appear. Shared by the per-session journal (#618)
 * and the workspace journal merge (#630).
 */
export function filterEntriesByKind<T extends { kind: SessionJournalKind }>(
  entries: readonly T[],
  kinds: ReadonlySet<SessionJournalKind> | undefined,
): T[] {
  if (kinds === undefined || kinds.size === 0) return [...entries];
  return entries.filter((e) => kinds.has(e.kind));
}

/** Inclusive epoch-millisecond bounds for a journal time window (#634). */
export interface JournalTimeWindow {
  /** Inclusive lower bound on entry `at`; undefined means unbounded. */
  since?: number;
  /** Inclusive upper bound on entry `at`; undefined means unbounded. */
  until?: number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Parse one --since/--until value (Issue #634). Accepts an ISO-8601
 * timestamp or a date-only value: a date-only --since means start of day
 * UTC and a date-only --until means end of day UTC (23:59:59.999). Throws
 * with a caller-ready message on anything unparseable so the CLI can fail
 * closed before any output.
 */
export function parseJournalTimestamp(raw: string, bound: "since" | "until"): number {
  const text = raw.trim();
  if (text === "") {
    throw new Error(`Error: --${bound} must not be blank`);
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const start = Date.UTC(year, month - 1, day);
    // Date.UTC rolls impossible components into the next month; reject that.
    const check = new Date(start);
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new Error(`Error: invalid --${bound} timestamp: "${raw}" (no such date)`);
    }
    return bound === "since" ? start : start + MS_PER_DAY - 1;
  }
  // Year-month alone would silently mean "only the first instant of the
  // month's first day" for --until; the contract is full timestamps or
  // whole dates, so fail closed instead.
  if (/^\d{4}-\d{2}$/.test(text)) {
    throw new Error(
      `Error: invalid --${bound} timestamp: "${raw}" (expected an ISO-8601 timestamp or a date YYYY-MM-DD)`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Error: invalid --${bound} timestamp: "${raw}" (expected an ISO-8601 timestamp or a date YYYY-MM-DD)`,
    );
  }
  return parsed;
}

/**
 * Filter journal entries to an inclusive time window (Issue #634). Undefined
 * means "no window" (all entries, order preserved). Shared by the
 * per-session journal (#618) and the workspace journal merge (#630).
 */
export function filterEntriesByWindow<T extends { at: number }>(
  entries: readonly T[],
  window: JournalTimeWindow | undefined,
): T[] {
  if (window === undefined) return [...entries];
  return entries.filter(
    (e) =>
      (window.since === undefined || e.at >= window.since) &&
      (window.until === undefined || e.at <= window.until),
  );
}

export interface SessionJournalEntry {
  /** Epoch ms when the event happened. */
  at: number;
  kind: SessionJournalKind;
  /** Human-readable, redacted detail for this event. */
  detail: string;
}

export interface SessionJournalRecord {
  schema: typeof SESSION_JOURNAL_SCHEMA;
  v: typeof SESSION_JOURNAL_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the journal. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Oldest first; ties break deterministically by kind, then detail. */
  entries: SessionJournalEntry[];
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Build one session's journal entries, chronological oldest-first with
 * deterministic tie-breaks (kind, then detail). Shared by the per-session
 * journal surface (#618) and the workspace-level merge (#630). Reading never
 * mutates the store; corrupt transcripts contribute their readable durable
 * state exactly as the per-session journal does.
 */
export function buildSessionJournalEntries(
  store: SessionStore,
  id: string,
): SessionJournalEntry[] {
  const entries: SessionJournalEntry[] = [];
  const diag = store.loadWithDiagnostics(id);

  if (typeof diag.meta?.createdAt === "number") {
    entries.push({ at: diag.meta.createdAt, kind: "created", detail: "session created" });
  }

  // Goal transitions from the stored history. Unreadable/absent goal
  // sidecars contribute nothing (honest absence). Legacy sidecars without a
  // history array surface the single synthesized legacy entry.
  const goalCheckpoint = store.readGoal(id);
  for (const h of goalHistoryForDisplay(goalCheckpoint)) {
    const label = h.objective === null ? "(cleared)" : redact(h.objective);
    entries.push({
      at: h.at,
      kind: "goal",
      detail: `${h.kind} · ${h.status ?? "—"} · ${label}`,
    });
  }

  // Notes ledger; an unreadable sidecar contributes nothing.
  const notesLoad = readSessionNotes(store, id);
  if (!notesLoad.corrupt) {
    for (const n of notesLoad.notes) {
      entries.push({ at: n.at, kind: "note", detail: `note added · ${redact(n.text)}` });
    }
  }

  const pinned = store.readPinned(id);
  if (pinned !== null) {
    entries.push({ at: pinned.at, kind: "pinned", detail: "pinned to the top of discovery" });
  }

  const archived = store.readArchived(id);
  if (archived !== null) {
    entries.push({ at: archived.at, kind: "archived", detail: "archived — retired from discovery" });
  }

  let lastModified: number | null = null;
  try {
    lastModified = fs.statSync(store.filePath(id)).mtimeMs;
  } catch {
    /* a vanished file contributes no last-activity entry */
  }
  if (lastModified !== null) {
    entries.push({
      at: Math.floor(lastModified),
      kind: "last-activity",
      detail: "transcript last modified",
    });
  }

  // Chronological, oldest first; equal timestamps break deterministically
  // by kind, then detail, so identical input always yields identical output.
  entries.sort(
    (a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail),
  );

  return entries;
}

/**
 * Build the journal for one session. Returns an error string (not throwing)
 * when the session is missing so the CLI can map it to a meaningful exit
 * status. Reading never mutates the store. An optional kind set filters the
 * entries (Issue #632) and an optional inclusive time window bounds them
 * (Issue #634); without either the journal is unchanged.
 */
export function buildSessionJournal(
  store: SessionStore,
  id: string,
  opts: { kinds?: ReadonlySet<SessionJournalKind>; window?: JournalTimeWindow } = {},
): { journal: SessionJournalRecord } | { error: string } {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") {
    return { error: `no such session "${id}"` };
  }
  return {
    journal: {
      schema: SESSION_JOURNAL_SCHEMA,
      v: SESSION_JOURNAL_VERSION,
      sessionId: id,
      integrity: integrity.status as SessionJournalRecord["integrity"],
      entries: filterEntriesByWindow(
        filterEntriesByKind(buildSessionJournalEntries(store, id), opts.kinds),
        opts.window,
      ),
    },
  };
}

export function formatSessionJournal(record: SessionJournalRecord): string[] {
  const lines: string[] = [];
  lines.push(`Session journal — ${shortSessionId(record.sessionId)} (${record.integrity})`);
  lines.push("─".repeat(40));
  lines.push("");
  if (record.entries.length === 0) {
    lines.push("No journal entries.");
    return lines;
  }
  for (const e of record.entries) {
    lines.push(`  ${new Date(e.at).toISOString()} · ${e.kind} · ${e.detail}`);
  }
  lines.push("");
  lines.push(`${record.entries.length} event(s).`);
  return lines;
}
