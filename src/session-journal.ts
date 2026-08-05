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
 * Reading direction for rendered journal entries (Issue #640). Journals
 * default to oldest-first ("how did this session get here?"); newest-first
 * is the explicit backward-reading mode.
 */
export const JOURNAL_ORDERS = ["oldest-first", "newest-first"] as const;

export type JournalOrder = (typeof JOURNAL_ORDERS)[number];

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
const RELATIVE_OFFSET = /^(\d+)([smhdw])$/;
const RELATIVE_UNIT_MS: Record<"s" | "m" | "h" | "d" | "w", number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: MS_PER_DAY,
  w: 7 * MS_PER_DAY,
};

/**
 * Parse one --since/--until value (Issue #634, extended by #652). Accepts
 * an ISO-8601 timestamp, a date-only value (a date-only --since means start
 * of day UTC and a date-only --until means end of day UTC 23:59:59.999), a
 * calendar word (Issue #654) — `today` or `yesterday`, resolved to the
 * start (for --since) or end (for --until) of the current or preceding UTC
 * day — or a relative spec resolved against the reference instant (read
 * time): `now`, or `<N><unit>` with units s/m/h/d/w meaning "N units ago"
 * (e.g. `2d` = two days before the reference). The reference instant is
 * injectable so resolution is deterministic under test. Throws with a
 * caller-ready message on anything unparseable so the CLI can fail closed
 * before any output.
 */
export function parseJournalTimestamp(
  raw: string,
  bound: "since" | "until",
  now?: number,
): number {
  const reference = now ?? Date.now();
  const text = raw.trim();
  if (text === "") {
    throw new Error(`Error: --${bound} must not be blank`);
  }
  if (text === "now") {
    return reference;
  }
  if (text === "today" || text === "yesterday") {
    const ref = new Date(reference);
    const startOfToday = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    const startOfDay = text === "today" ? startOfToday : startOfToday - MS_PER_DAY;
    return bound === "since" ? startOfDay : startOfDay + MS_PER_DAY - 1;
  }
  const relative = RELATIVE_OFFSET.exec(text);
  if (relative !== null) {
    const count = Number(relative[1]);
    const unit = relative[2] as "s" | "m" | "h" | "d" | "w";
    return reference - count * RELATIVE_UNIT_MS[unit];
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
      `Error: invalid --${bound} timestamp: "${raw}" (expected an ISO-8601 timestamp, a date YYYY-MM-DD, a relative offset like 30s/45m/6h/2d/1w/now, or today/yesterday)`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Error: invalid --${bound} timestamp: "${raw}" (expected an ISO-8601 timestamp, a date YYYY-MM-DD, a relative offset like 30s/45m/6h/2d/1w/now, or today/yesterday)`,
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

/**
 * Parse a positive-integer count flag (--limit/#636, --skip/#638) from its
 * decimal string form. Throws with a caller-ready message on anything else
 * so the CLI can fail closed before any output.
 */
function parsePositiveCount(raw: string, flag: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Error: invalid ${flag} value: "${raw}" (expected a positive integer)`);
  }
  const value = Number(text);
  if (value === 0 || !Number.isSafeInteger(value)) {
    throw new Error(`Error: invalid ${flag} value: "${raw}" (expected a positive integer)`);
  }
  return value;
}

/** Parse the --limit value (Issue #636). */
export function parseJournalLimit(raw: string): number {
  return parsePositiveCount(raw, "--limit");
}

/** Parse the --skip value (Issue #638). */
export function parseJournalSkip(raw: string): number {
  return parsePositiveCount(raw, "--skip");
}

/**
 * Keep only the newest `limit` entries of an oldest-first journal sequence
 * (Issue #636), reporting how many older entries were elided. Undefined
 * means "no limit" (all entries, order preserved, nothing elided). Shared
 * by the per-session journal (#618) and the workspace journal merge (#630).
 */
export function applyJournalLimit<T>(
  entries: readonly T[],
  limit: number | undefined,
): { entries: T[]; elided: number } {
  if (limit === undefined) return { entries: [...entries], elided: 0 };
  const elided = Math.max(0, entries.length - limit);
  return { entries: entries.slice(elided), elided };
}

/**
 * Set aside the newest `skip` entries of an oldest-first journal sequence
 * (Issue #638), keeping the entries before them and reporting how many
 * newer entries were skipped. Undefined means "no skip" (all entries, order
 * preserved, nothing skipped); a skip at or beyond the count yields an empty
 * kept set with a truthful skipped count. Shared by the per-session journal
 * (#618) and the workspace journal merge (#630).
 */
export function applyJournalSkip<T>(
  entries: readonly T[],
  skip: number | undefined,
): { entries: T[]; skipped: number } {
  if (skip === undefined) return { entries: [...entries], skipped: 0 };
  const skipped = Math.min(skip, entries.length);
  return { entries: entries.slice(0, entries.length - skipped), skipped };
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
  /**
   * Ordered per the record's `order` field; ties always broke
   * deterministically by kind, then detail, before ordering.
   */
  entries: SessionJournalEntry[];
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
  /** Rendering direction (Issue #640); oldest-first unless --newest-first. */
  order: JournalOrder;
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
 * entries (Issue #632), an optional inclusive time window bounds them
 * (Issue #634), an optional skip sets aside the newest entries, and an
 * optional limit keeps only the newest of what remains (Issue #636/#638);
 * without any of these the journal is unchanged. An optional newest-first
 * flag (Issue #640) flips the rendering direction of the final kept set
 * only — every filter and bound applies exactly as in oldest-first mode.
 */
export function buildSessionJournal(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
    newestFirst?: boolean;
  } = {},
): { journal: SessionJournalRecord } | { error: string } {
  const integrity = store.integrity(id);
  if (integrity.status === "missing") {
    return { error: `no such session "${id}"` };
  }
  const filtered = filterEntriesByWindow(
    filterEntriesByKind(buildSessionJournalEntries(store, id), opts.kinds),
    opts.window,
  );
  // Skip sets aside the newest entries first (Issue #638); limit then bounds
  // the remainder (Issue #636), so elision counts reflect the skip-remainder.
  const skippedAside = applyJournalSkip(filtered, opts.skip);
  const limited = applyJournalLimit(skippedAside.entries, opts.limit);
  const order: JournalOrder = opts.newestFirst === true ? "newest-first" : "oldest-first";
  return {
    journal: {
      schema: SESSION_JOURNAL_SCHEMA,
      v: SESSION_JOURNAL_VERSION,
      sessionId: id,
      integrity: integrity.status as SessionJournalRecord["integrity"],
      entries: order === "newest-first" ? [...limited.entries].reverse() : limited.entries,
      elided: limited.elided,
      skipped: skippedAside.skipped,
      order,
    },
  };
}

/**
 * Render one timestamp's age relative to a reference instant (Issue #650).
 * Fixed honest buckets: `just now` (< 60s), `Nm ago` (< 60m), `Nh ago`
 * (< 24h), `Nd ago` (< 30d), and the absolute UTC date YYYY-MM-DD for
 * anything older. Future timestamps (clock drift) clamp to `just now` —
 * never a negative age. Pure: the reference instant is injectable so every
 * bucket boundary is deterministic under test. Shared by both journal
 * surfaces.
 */
export function formatRelativeAge(at: number, now: number): string {
  const delta = now - at;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

export function formatSessionJournal(
  record: SessionJournalRecord,
  opts: { relative?: boolean; now?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const stamp = (at: number): string =>
    opts.relative === true ? formatRelativeAge(at, now) : new Date(at).toISOString();
  const lines: string[] = [];
  lines.push(`Session journal — ${shortSessionId(record.sessionId)} (${record.integrity})`);
  lines.push("─".repeat(40));
  lines.push("");
  if (record.entries.length === 0) {
    lines.push("No journal entries.");
    if (record.skipped > 0) {
      lines.push(`(+${record.skipped} newer event(s) skipped.)`);
    }
    return lines;
  }
  for (const e of record.entries) {
    lines.push(`  ${stamp(e.at)} · ${e.kind} · ${e.detail}`);
  }
  lines.push("");
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  lines.push(`${record.entries.length} event(s).${elidedNote}${skippedNote}`);
  return lines;
}

export const SESSION_JOURNAL_COUNT_SCHEMA = "oh-my-cli.session-journal-count" as const;
export const SESSION_JOURNAL_COUNT_VERSION = 1 as const;

/**
 * Counts-only view of one session's journal (Issue #642): the size of the
 * kept set after every filter and bound, never entry contents — for scripts
 * that only need to know how many events match.
 */
export interface SessionJournalCountRecord {
  schema: typeof SESSION_JOURNAL_COUNT_SCHEMA;
  v: typeof SESSION_JOURNAL_COUNT_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the count. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Entries kept after every filter and bound. */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the counts-only journal record for one session (Issue #642).
 * Semantics are exactly `buildSessionJournal`'s — same pipeline, same
 * heal-free resolution, same error string for a missing session — but the
 * result carries counts only, never entry contents. Rendering direction is
 * meaningless for a size, so no newest-first option exists here.
 */
export function buildSessionJournalCount(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { count: SessionJournalCountRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    count: {
      schema: SESSION_JOURNAL_COUNT_SCHEMA,
      v: SESSION_JOURNAL_COUNT_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalCount(record: SessionJournalCountRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  return [`${record.count} event(s).${elidedNote}${skippedNote}`];
}

/**
 * Tally journal entries by kind (Issue #644): a partial map over the closed
 * taxonomy, in fixed taxonomy order, containing only kinds present in the
 * given sequence. Shared by the per-session journal (#618) and the workspace
 * journal merge (#630).
 */
export function tallyEntriesByKind<T extends { kind: SessionJournalKind }>(
  entries: readonly T[],
): Partial<Record<SessionJournalKind, number>> {
  const byKind: Partial<Record<SessionJournalKind, number>> = {};
  for (const kind of JOURNAL_KINDS) {
    const n = entries.reduce((acc, e) => (e.kind === kind ? acc + 1 : acc), 0);
    if (n > 0) byKind[kind] = n;
  }
  return byKind;
}

export const SESSION_JOURNAL_SUMMARY_SCHEMA = "oh-my-cli.session-journal-summary" as const;
export const SESSION_JOURNAL_SUMMARY_VERSION = 1 as const;

/**
 * Per-kind summary of one session's journal (Issue #644): the shape of the
 * kept set after every filter and bound, never entry contents — for reading
 * what a history is made of without rendering it.
 */
export interface SessionJournalSummaryRecord {
  schema: typeof SESSION_JOURNAL_SUMMARY_SCHEMA;
  v: typeof SESSION_JOURNAL_SUMMARY_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the summary. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Per-kind tallies of the kept set, taxonomy order, present kinds only. */
  byKind: Partial<Record<SessionJournalKind, number>>;
  /** Entries kept after every filter and bound (sums with `byKind`). */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-kind summary record for one session (Issue #644). Semantics
 * are exactly `buildSessionJournal`'s — same pipeline, same heal-free
 * resolution, same error string for a missing session — but the result
 * carries tallies only, never entry contents. Aggregation is
 * order-independent, so no newest-first option exists here.
 */
export function buildSessionJournalSummary(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { summary: SessionJournalSummaryRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    summary: {
      schema: SESSION_JOURNAL_SUMMARY_SCHEMA,
      v: SESSION_JOURNAL_SUMMARY_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      byKind: tallyEntriesByKind(built.journal.entries),
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalSummary(record: SessionJournalSummaryRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const parts = JOURNAL_KINDS.filter((k) => record.byKind[k] !== undefined).map(
    (k) => `${k} ×${record.byKind[k]}`,
  );
  return [`${record.count} event(s): ${parts.join(", ")}.${elidedNote}${skippedNote}`];
}

/** One per-UTC-day bucket of journal entries (Issue #646). */
export interface JournalDayBucket {
  /** The UTC calendar day, YYYY-MM-DD. */
  day: string;
  /** Kept entries whose timestamp falls on that day. */
  count: number;
}

/**
 * Bucket journal entries by UTC calendar day (Issue #646): chronological
 * (oldest day first), containing only days present in the given sequence.
 * Shared by the per-session journal (#618) and the workspace journal merge
 * (#630).
 */
export function bucketEntriesByDay<T extends { at: number }>(
  entries: readonly T[],
): JournalDayBucket[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const day = new Date(e.at).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));
}

export const SESSION_JOURNAL_BY_DAY_SCHEMA = "oh-my-cli.session-journal-by-day" as const;
export const SESSION_JOURNAL_BY_DAY_VERSION = 1 as const;

/**
 * Per-day grouping of one session's journal (Issue #646): when the kept set
 * happened, never what it says — day buckets and counts only, for reading
 * the rhythm of a history without rendering it.
 */
export interface SessionJournalByDayRecord {
  schema: typeof SESSION_JOURNAL_BY_DAY_SCHEMA;
  v: typeof SESSION_JOURNAL_BY_DAY_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the grouping. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Per-UTC-day buckets of the kept set, chronological, present days only. */
  byDay: JournalDayBucket[];
  /** Entries kept after every filter and bound (sums with `byDay`). */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-day grouping record for one session (Issue #646). Semantics
 * are exactly `buildSessionJournal`'s — same pipeline, same heal-free
 * resolution, same error string for a missing session — but the result
 * carries day buckets only, never entry contents. Bucketing fixes the
 * order, so no newest-first option exists here.
 */
export function buildSessionJournalByDay(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { byDay: SessionJournalByDayRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    byDay: {
      schema: SESSION_JOURNAL_BY_DAY_SCHEMA,
      v: SESSION_JOURNAL_BY_DAY_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      byDay: bucketEntriesByDay(built.journal.entries),
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalByDay(record: SessionJournalByDayRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const lines = [
    `${record.count} event(s) across ${record.byDay.length} day(s).${elidedNote}${skippedNote}`,
  ];
  for (const b of record.byDay) {
    lines.push(`  ${b.day} ×${b.count}`);
  }
  return lines;
}

/** One per-UTC-hour bucket of journal entries (Issue #656). */
export interface JournalHourBucket {
  /** The UTC hour, YYYY-MM-DDTHH. */
  hour: string;
  /** Kept entries whose timestamp falls in that hour. */
  count: number;
}

/**
 * Bucket journal entries by UTC hour (Issue #656): chronological (oldest
 * hour first), containing only hours present in the given sequence. Shared
 * by the per-session journal (#618) and the workspace journal merge (#630).
 */
export function bucketEntriesByHour<T extends { at: number }>(
  entries: readonly T[],
): JournalHourBucket[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const hour = new Date(e.at).toISOString().slice(0, 13);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, count]) => ({ hour, count }));
}

export const SESSION_JOURNAL_BY_HOUR_SCHEMA = "oh-my-cli.session-journal-by-hour" as const;
export const SESSION_JOURNAL_BY_HOUR_VERSION = 1 as const;

/**
 * Per-hour grouping of one session's journal (Issue #656): when the kept
 * set happened at hour granularity, never what it says — hour buckets and
 * counts only. Same shape as the per-day grouping (#646), one level finer.
 */
export interface SessionJournalByHourRecord {
  schema: typeof SESSION_JOURNAL_BY_HOUR_SCHEMA;
  v: typeof SESSION_JOURNAL_BY_HOUR_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the grouping. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Per-UTC-hour buckets of the kept set, chronological, present hours only. */
  byHour: JournalHourBucket[];
  /** Entries kept after every filter and bound (sums with `byHour`). */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-hour grouping record for one session (Issue #656).
 * Semantics are exactly `buildSessionJournal`'s — same pipeline, same
 * heal-free resolution, same error string for a missing session — but the
 * result carries hour buckets only, never entry contents. Bucketing fixes
 * the order, so no newest-first option exists here.
 */
export function buildSessionJournalByHour(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { byHour: SessionJournalByHourRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    byHour: {
      schema: SESSION_JOURNAL_BY_HOUR_SCHEMA,
      v: SESSION_JOURNAL_BY_HOUR_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      byHour: bucketEntriesByHour(built.journal.entries),
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalByHour(record: SessionJournalByHourRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const lines = [
    `${record.count} event(s) across ${record.byHour.length} hour(s).${elidedNote}${skippedNote}`,
  ];
  for (const b of record.byHour) {
    lines.push(`  ${b.hour} ×${b.count}`);
  }
  return lines;
}

/**
 * Compute the ISO-8601 week key `YYYY-Www` of a UTC timestamp (Issue #658).
 * Weeks start on Monday and week 1 contains the year's first Thursday; the
 * key carries the ISO week-year, not the calendar year — early-January days
 * can resolve into the previous year's last week and late-December days
 * into the next year's week 1.
 */
export function isoWeekKey(at: number): string {
  const d = new Date(at);
  const dateUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // Monday=1 … Sunday=7; the Thursday of the same ISO week determines the
  // week-year and the week number.
  const dayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  const thursday = dateUtc + (4 - dayOfWeek) * MS_PER_DAY;
  const thursdayDate = new Date(thursday);
  const isoYear = thursdayDate.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / (7 * MS_PER_DAY)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** One per-ISO-week bucket of journal entries (Issue #658). */
export interface JournalWeekBucket {
  /** The ISO-8601 week, YYYY-Www. */
  week: string;
  /** Kept entries whose timestamp falls in that week. */
  count: number;
}

/**
 * Bucket journal entries by ISO-8601 week (Issue #658): chronological
 * (oldest week first — week-year keys sort chronologically), containing only
 * weeks present in the given sequence. Shared by the per-session journal
 * (#618) and the workspace journal merge (#630).
 */
export function bucketEntriesByWeek<T extends { at: number }>(
  entries: readonly T[],
): JournalWeekBucket[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const week = isoWeekKey(e.at);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, count]) => ({ week, count }));
}

export const SESSION_JOURNAL_BY_WEEK_SCHEMA = "oh-my-cli.session-journal-by-week" as const;
export const SESSION_JOURNAL_BY_WEEK_VERSION = 1 as const;

/**
 * Per-week grouping of one session's journal (Issue #658): when the kept
 * set happened at ISO-week granularity, never what it says — week buckets
 * and counts only. Same shape as the per-day grouping (#646), one level
 * coarser.
 */
export interface SessionJournalByWeekRecord {
  schema: typeof SESSION_JOURNAL_BY_WEEK_SCHEMA;
  v: typeof SESSION_JOURNAL_BY_WEEK_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the grouping. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Per-ISO-week buckets of the kept set, chronological, present weeks only. */
  byWeek: JournalWeekBucket[];
  /** Entries kept after every filter and bound (sums with `byWeek`). */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-week grouping record for one session (Issue #658).
 * Semantics are exactly `buildSessionJournal`'s — same pipeline, same
 * heal-free resolution, same error string for a missing session — but the
 * result carries week buckets only, never entry contents. Bucketing fixes
 * the order, so no newest-first option exists here.
 */
export function buildSessionJournalByWeek(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { byWeek: SessionJournalByWeekRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    byWeek: {
      schema: SESSION_JOURNAL_BY_WEEK_SCHEMA,
      v: SESSION_JOURNAL_BY_WEEK_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      byWeek: bucketEntriesByWeek(built.journal.entries),
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalByWeek(record: SessionJournalByWeekRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const lines = [
    `${record.count} event(s) across ${record.byWeek.length} week(s).${elidedNote}${skippedNote}`,
  ];
  for (const b of record.byWeek) {
    lines.push(`  ${b.week} ×${b.count}`);
  }
  return lines;
}

/** One per-calendar-month bucket of journal entries (Issue #660). */
export interface JournalMonthBucket {
  /** The UTC calendar month, YYYY-MM. */
  month: string;
  /** Kept entries whose timestamp falls in that month. */
  count: number;
}

/**
 * Bucket journal entries by UTC calendar month (Issue #660): chronological
 * (oldest month first — month keys sort chronologically, including across
 * year boundaries), containing only months present in the given sequence.
 * Shared by the per-session journal (#618) and the workspace journal merge
 * (#630).
 */
export function bucketEntriesByMonth<T extends { at: number }>(
  entries: readonly T[],
): JournalMonthBucket[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const month = new Date(e.at).toISOString().slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, count]) => ({ month, count }));
}

export const SESSION_JOURNAL_BY_MONTH_SCHEMA = "oh-my-cli.session-journal-by-month" as const;
export const SESSION_JOURNAL_BY_MONTH_VERSION = 1 as const;

/**
 * Per-month grouping of one session's journal (Issue #660): when the kept
 * set happened at calendar-month granularity, never what it says — month
 * buckets and counts only. Same shape as the per-day grouping (#646), at
 * the coarsest level of the time-bucket series.
 */
export interface SessionJournalByMonthRecord {
  schema: typeof SESSION_JOURNAL_BY_MONTH_SCHEMA;
  v: typeof SESSION_JOURNAL_BY_MONTH_VERSION;
  sessionId: string;
  /** Transcript integrity at read time — honest context for the grouping. */
  integrity: "ok" | "partial" | "corrupt" | "missing";
  /** Per-month buckets of the kept set, chronological, present months only. */
  byMonth: JournalMonthBucket[];
  /** Entries kept after every filter and bound (sums with `byMonth`). */
  count: number;
  /** Older entries dropped by --limit (Issue #636); 0 without it. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-month grouping record for one session (Issue #660).
 * Semantics are exactly `buildSessionJournal`'s — same pipeline, same
 * heal-free resolution, same error string for a missing session — but the
 * result carries month buckets only, never entry contents. Bucketing fixes
 * the order, so no newest-first option exists here.
 */
export function buildSessionJournalByMonth(
  store: SessionStore,
  id: string,
  opts: {
    kinds?: ReadonlySet<SessionJournalKind>;
    window?: JournalTimeWindow;
    skip?: number;
    limit?: number;
  } = {},
): { byMonth: SessionJournalByMonthRecord } | { error: string } {
  const built = buildSessionJournal(store, id, opts);
  if ("error" in built) return { error: built.error };
  return {
    byMonth: {
      schema: SESSION_JOURNAL_BY_MONTH_SCHEMA,
      v: SESSION_JOURNAL_BY_MONTH_VERSION,
      sessionId: built.journal.sessionId,
      integrity: built.journal.integrity,
      byMonth: bucketEntriesByMonth(built.journal.entries),
      count: built.journal.entries.length,
      elided: built.journal.elided,
      skipped: built.journal.skipped,
    },
  };
}

export function formatSessionJournalByMonth(record: SessionJournalByMonthRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const lines = [
    `${record.count} event(s) across ${record.byMonth.length} month(s).${elidedNote}${skippedNote}`,
  ];
  for (const b of record.byMonth) {
    lines.push(`  ${b.month} ×${b.count}`);
  }
  return lines;
}
