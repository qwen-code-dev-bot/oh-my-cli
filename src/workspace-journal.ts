// Workspace-level merged durable journal (Issue #630).
//
// The per-session journal (#618) answers "how did this session get here?";
// nothing answers "what happened in this workspace recently?" without
// journaling each session by hand. This module merges the durable journals
// of every session declared for a workspace's canonical identity into one
// bounded chronology, tagged per session.
//
// Semantics follow the established family conventions: canonical workspace
// identity via workspaceTrustKey (#596 — symlink aliases and linked
// worktrees collapse), archived sessions skipped (discovery semantics),
// corrupt sessions contribute their readable durable state with their
// verdict, redaction on every free-form value, deterministic ordering, and
// zero mutation of the store. Rendering is bounded: the newest entries are
// kept (rendered oldest-first within the kept window) with a truthful
// elided count for the older tail.

import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { workspaceTrustKey } from "./folder-trust.js";
import { buildSessionJournalEntries, JOURNAL_KINDS } from "./session-journal.js";
import {
  applyJournalSkip,
  bucketEntriesByDay,
  filterEntriesByKind,
  filterEntriesByWindow,
  formatRelativeAge,
  tallyEntriesByKind,
} from "./session-journal.js";
import type {
  JournalDayBucket,
  JournalOrder,
  JournalTimeWindow,
  SessionJournalKind,
} from "./session-journal.js";

export const WORKSPACE_JOURNAL_SCHEMA = "oh-my-cli.workspace-journal" as const;
export const WORKSPACE_JOURNAL_VERSION = 1 as const;
/** Bound on merged entries kept before elision. */
export const WORKSPACE_JOURNAL_MAX_ENTRIES = 50;

export interface WorkspaceJournalEntry {
  /** Epoch ms when the event happened. */
  at: number;
  kind: SessionJournalKind;
  /** Human-readable, redacted detail for this event. */
  detail: string;
  sessionId: string;
  shortId: string;
  /** Present only when the session's transcript is not fully healthy. */
  integrity?: "partial" | "corrupt";
}

export interface WorkspaceJournalRecord {
  schema: typeof WORKSPACE_JOURNAL_SCHEMA;
  v: typeof WORKSPACE_JOURNAL_VERSION;
  /** The workspace the journal is scoped to, redacted + home-collapsed. */
  workspace: string;
  /** Sessions whose journals were merged. */
  sessionsScanned: number;
  /** Workspace sessions skipped because they are archived. */
  sessionsSkippedArchived: number;
  /** Newest entries kept; rendered per the record's `order` field. */
  entries: WorkspaceJournalEntry[];
  /** Older entries dropped by the bound. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
  /** Rendering direction (Issue #640); oldest-first unless --newest-first. */
  order: JournalOrder;
}

export interface WorkspaceJournalOptions {
  workspace: string;
  /** Injectable identity function for deterministic tests. */
  keyOf?: (workspacePath: string) => string;
  /** Bound override for tests. */
  maxEntries?: number;
  /** Entry-kind filter (Issue #632); undefined means no filter. */
  kinds?: ReadonlySet<SessionJournalKind>;
  /** Inclusive time window (Issue #634); undefined means no window. */
  window?: JournalTimeWindow;
  /**
   * Caller-controlled newest-N bound (Issue #636). When set it replaces the
   * default bound entirely (callers may tighten below or expand above it).
   */
  limit?: number;
  /** Set aside the newest entries before bounding (Issue #638). */
  skip?: number;
  /**
   * Render the final kept set newest-first (Issue #640). Applies strictly
   * after scoping, window, kind, skip, and the bound.
   */
  newestFirst?: boolean;
}

export function buildWorkspaceJournal(
  store: SessionStore,
  opts: WorkspaceJournalOptions,
): WorkspaceJournalRecord {
  const keyOf = opts.keyOf ?? workspaceTrustKey;
  const targetKey = keyOf(opts.workspace);
  // A caller-supplied --limit (Issue #636) replaces the default bound;
  // otherwise fall back to the test override, then the default.
  const maxEntries = opts.limit ?? opts.maxEntries ?? WORKSPACE_JOURNAL_MAX_ENTRIES;

  const merged: WorkspaceJournalEntry[] = [];
  let sessionsScanned = 0;
  let sessionsSkippedArchived = 0;

  for (const id of [...store.listIds()].sort()) {
    // Archived sessions are retired from discovery (Issue #598); the
    // workspace journal stays consistent with that semantics.
    if (store.readArchived(id) !== null) {
      sessionsSkippedArchived++;
      continue;
    }
    const declared = store.readMeta(id)?.workspace;
    if (declared === undefined || declared === "") continue;
    let key: string;
    try {
      key = keyOf(declared);
    } catch {
      continue;
    }
    if (key !== targetKey) continue;

    sessionsScanned++;
    const integrity = store.integrity(id).status;
    const tag =
      integrity === "partial" || integrity === "corrupt"
        ? { integrity: integrity as "partial" | "corrupt" }
        : {};
    const shortId = shortSessionId(id);
    for (const e of buildSessionJournalEntries(store, id)) {
      merged.push({ ...e, sessionId: id, shortId, ...tag });
    }
  }

  // Global chronology, oldest first; deterministic tie-breaks (session id,
  // then kind, then detail) so identical stores yield identical output.
  merged.sort(
    (a, b) =>
      a.at - b.at ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.kind.localeCompare(b.kind) ||
      a.detail.localeCompare(b.detail),
  );

  // Keep the newest entries; elide the older tail with a truthful count.
  // The time window (Issue #634) and the kind filter (Issue #632) apply
  // first; skip (Issue #638) sets aside the newest of the filtered set; the
  // bound then applies to the skip-remainder, so elision counts reflect it.
  // Scoping and archived-skipping already happened during the merge above.
  const windowed = filterEntriesByWindow(merged, opts.window);
  const filtered = filterEntriesByKind(windowed, opts.kinds);
  const skippedAside = applyJournalSkip(filtered, opts.skip);
  const elided = Math.max(0, skippedAside.entries.length - maxEntries);
  const bounded = skippedAside.entries.slice(elided);
  const order: JournalOrder = opts.newestFirst === true ? "newest-first" : "oldest-first";
  const entries = order === "newest-first" ? [...bounded].reverse() : bounded;

  return {
    schema: WORKSPACE_JOURNAL_SCHEMA,
    v: WORKSPACE_JOURNAL_VERSION,
    workspace: redactSecrets(redactHomePath(opts.workspace)).text,
    sessionsScanned,
    sessionsSkippedArchived,
    entries,
    elided,
    skipped: skippedAside.skipped,
    order,
  };
}

export function formatWorkspaceJournal(
  record: WorkspaceJournalRecord,
  opts: { relative?: boolean; now?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const stamp = (at: number): string =>
    opts.relative === true ? formatRelativeAge(at, now) : new Date(at).toISOString();
  const lines: string[] = [];
  lines.push(`Workspace journal — ${record.workspace}`);
  lines.push("─".repeat(40));
  lines.push("");
  lines.push(
    `Sessions merged: ${record.sessionsScanned}` +
      (record.sessionsSkippedArchived > 0
        ? ` (skipped ${record.sessionsSkippedArchived} archived)`
        : ""),
  );
  if (record.entries.length === 0) {
    lines.push("");
    lines.push("No journal entries for this workspace.");
    if (record.skipped > 0) {
      lines.push(`(+${record.skipped} newer event(s) skipped.)`);
    }
    return lines;
  }
  lines.push("");
  for (const e of record.entries) {
    const verdict = e.integrity !== undefined ? ` (${e.integrity})` : "";
    lines.push(
      `  ${stamp(e.at)} · ${e.shortId}${verdict} · ${e.kind} · ${e.detail}`,
    );
  }
  lines.push("");
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  lines.push(`${record.entries.length} event(s) shown.${elidedNote}${skippedNote}`);
  return lines;
}

export const WORKSPACE_JOURNAL_COUNT_SCHEMA = "oh-my-cli.workspace-journal-count" as const;
export const WORKSPACE_JOURNAL_COUNT_VERSION = 1 as const;

/**
 * Counts-only view of the merged workspace journal (Issue #642): the size of
 * the kept set after scoping and every filter/bound, never entry contents —
 * for scripts that only need to know how many events match.
 */
export interface WorkspaceJournalCountRecord {
  schema: typeof WORKSPACE_JOURNAL_COUNT_SCHEMA;
  v: typeof WORKSPACE_JOURNAL_COUNT_VERSION;
  /** The workspace the count is scoped to, redacted + home-collapsed. */
  workspace: string;
  /** Sessions whose journals were merged. */
  sessionsScanned: number;
  /** Workspace sessions skipped because they are archived. */
  sessionsSkippedArchived: number;
  /** Entries kept after every filter and bound. */
  count: number;
  /** Older entries dropped by the bound. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the counts-only workspace journal record (Issue #642). Semantics are
 * exactly `buildWorkspaceJournal`'s — same scoping, filters, and bounds —
 * but the result carries counts only, never entry contents. Rendering
 * direction is meaningless for a size, so no newest-first option exists here.
 */
export function buildWorkspaceJournalCount(
  store: SessionStore,
  opts: Omit<WorkspaceJournalOptions, "newestFirst">,
): WorkspaceJournalCountRecord {
  const journal = buildWorkspaceJournal(store, opts);
  return {
    schema: WORKSPACE_JOURNAL_COUNT_SCHEMA,
    v: WORKSPACE_JOURNAL_COUNT_VERSION,
    workspace: journal.workspace,
    sessionsScanned: journal.sessionsScanned,
    sessionsSkippedArchived: journal.sessionsSkippedArchived,
    count: journal.entries.length,
    elided: journal.elided,
    skipped: journal.skipped,
  };
}

export function formatWorkspaceJournalCount(record: WorkspaceJournalCountRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  return [`${record.count} event(s).${elidedNote}${skippedNote}`];
}

export const WORKSPACE_JOURNAL_SUMMARY_SCHEMA = "oh-my-cli.workspace-journal-summary" as const;
export const WORKSPACE_JOURNAL_SUMMARY_VERSION = 1 as const;

/**
 * Per-kind summary of the merged workspace journal (Issue #644): the shape
 * of the kept set after scoping and every filter/bound, never entry contents
 * — for reading what a workspace's recent history is made of.
 */
export interface WorkspaceJournalSummaryRecord {
  schema: typeof WORKSPACE_JOURNAL_SUMMARY_SCHEMA;
  v: typeof WORKSPACE_JOURNAL_SUMMARY_VERSION;
  /** The workspace the summary is scoped to, redacted + home-collapsed. */
  workspace: string;
  /** Sessions whose journals were merged. */
  sessionsScanned: number;
  /** Workspace sessions skipped because they are archived. */
  sessionsSkippedArchived: number;
  /** Per-kind tallies of the kept set, taxonomy order, present kinds only. */
  byKind: Partial<Record<SessionJournalKind, number>>;
  /** Entries kept after every filter and bound (sums with `byKind`). */
  count: number;
  /** Older entries dropped by the bound. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-kind summary record for a workspace (Issue #644). Semantics
 * are exactly `buildWorkspaceJournal`'s — same scoping, filters, and bounds —
 * but the result carries tallies only, never entry contents. Aggregation is
 * order-independent, so no newest-first option exists here.
 */
export function buildWorkspaceJournalSummary(
  store: SessionStore,
  opts: Omit<WorkspaceJournalOptions, "newestFirst">,
): WorkspaceJournalSummaryRecord {
  const journal = buildWorkspaceJournal(store, opts);
  return {
    schema: WORKSPACE_JOURNAL_SUMMARY_SCHEMA,
    v: WORKSPACE_JOURNAL_SUMMARY_VERSION,
    workspace: journal.workspace,
    sessionsScanned: journal.sessionsScanned,
    sessionsSkippedArchived: journal.sessionsSkippedArchived,
    byKind: tallyEntriesByKind(journal.entries),
    count: journal.entries.length,
    elided: journal.elided,
    skipped: journal.skipped,
  };
}

export function formatWorkspaceJournalSummary(record: WorkspaceJournalSummaryRecord): string[] {
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

export const WORKSPACE_JOURNAL_BY_DAY_SCHEMA = "oh-my-cli.workspace-journal-by-day" as const;
export const WORKSPACE_JOURNAL_BY_DAY_VERSION = 1 as const;

/**
 * Per-day grouping of the merged workspace journal (Issue #646): when the
 * kept set happened, never what it says — day buckets and counts only, for
 * reading the rhythm of a workspace's recent history.
 */
export interface WorkspaceJournalByDayRecord {
  schema: typeof WORKSPACE_JOURNAL_BY_DAY_SCHEMA;
  v: typeof WORKSPACE_JOURNAL_BY_DAY_VERSION;
  /** The workspace the grouping is scoped to, redacted + home-collapsed. */
  workspace: string;
  /** Sessions whose journals were merged. */
  sessionsScanned: number;
  /** Workspace sessions skipped because they are archived. */
  sessionsSkippedArchived: number;
  /** Per-UTC-day buckets of the kept set, chronological, present days only. */
  byDay: JournalDayBucket[];
  /** Entries kept after every filter and bound (sums with `byDay`). */
  count: number;
  /** Older entries dropped by the bound. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-day grouping record for a workspace (Issue #646). Semantics
 * are exactly `buildWorkspaceJournal`'s — same scoping, filters, and bounds —
 * but the result carries day buckets only, never entry contents. Bucketing
 * fixes the order, so no newest-first option exists here.
 */
export function buildWorkspaceJournalByDay(
  store: SessionStore,
  opts: Omit<WorkspaceJournalOptions, "newestFirst">,
): WorkspaceJournalByDayRecord {
  const journal = buildWorkspaceJournal(store, opts);
  return {
    schema: WORKSPACE_JOURNAL_BY_DAY_SCHEMA,
    v: WORKSPACE_JOURNAL_BY_DAY_VERSION,
    workspace: journal.workspace,
    sessionsScanned: journal.sessionsScanned,
    sessionsSkippedArchived: journal.sessionsSkippedArchived,
    byDay: bucketEntriesByDay(journal.entries),
    count: journal.entries.length,
    elided: journal.elided,
    skipped: journal.skipped,
  };
}

export function formatWorkspaceJournalByDay(record: WorkspaceJournalByDayRecord): string[] {
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

/** One contributing-session bucket of the merged workspace journal (#648). */
export interface WorkspaceSessionBucket {
  /** Short display id of the contributing session. */
  shortId: string;
  /** Full id of the contributing session. */
  sessionId: string;
  /** Kept entries contributed by that session. */
  count: number;
}

/**
 * Bucket merged workspace journal entries by contributing session
 * (Issue #648): count descending, ties broken by full session id ascending
 * so identical stores always yield identical output. Contains only sessions
 * present in the given sequence.
 */
export function bucketWorkspaceEntriesBySession(
  entries: readonly WorkspaceJournalEntry[],
): WorkspaceSessionBucket[] {
  const counts = new Map<string, { shortId: string; count: number }>();
  for (const e of entries) {
    const bucket = counts.get(e.sessionId);
    if (bucket === undefined) {
      counts.set(e.sessionId, { shortId: e.shortId, count: 1 });
    } else {
      bucket.count += 1;
    }
  }
  return [...counts.entries()]
    .map(([sessionId, b]) => ({ sessionId, shortId: b.shortId, count: b.count }))
    .sort((a, b) => b.count - a.count || a.sessionId.localeCompare(b.sessionId));
}

export const WORKSPACE_JOURNAL_BY_SESSION_SCHEMA = "oh-my-cli.workspace-journal-by-session" as const;
export const WORKSPACE_JOURNAL_BY_SESSION_VERSION = 1 as const;

/**
 * Per-session grouping of the merged workspace journal (Issue #648): which
 * sessions the kept set came from, never what it says — session identifiers
 * and counts only. Grouping a single-session journal by session is
 * meaningless, so this is a workspace-surface mode.
 */
export interface WorkspaceJournalBySessionRecord {
  schema: typeof WORKSPACE_JOURNAL_BY_SESSION_SCHEMA;
  v: typeof WORKSPACE_JOURNAL_BY_SESSION_VERSION;
  /** The workspace the grouping is scoped to, redacted + home-collapsed. */
  workspace: string;
  /** Sessions whose journals were merged. */
  sessionsScanned: number;
  /** Workspace sessions skipped because they are archived. */
  sessionsSkippedArchived: number;
  /** Per-session buckets of the kept set, count desc, sessionId tie-break. */
  bySession: WorkspaceSessionBucket[];
  /** Entries kept after every filter and bound (sums with `bySession`). */
  count: number;
  /** Older entries dropped by the bound. */
  elided: number;
  /** Newer entries set aside by --skip (Issue #638); 0 without it. */
  skipped: number;
}

/**
 * Build the per-session grouping record for a workspace (Issue #648).
 * Semantics are exactly `buildWorkspaceJournal`'s — same scoping, filters,
 * and bounds — but the result carries session buckets only, never entry
 * contents. Bucketing fixes the order, so no newest-first option exists
 * here.
 */
export function buildWorkspaceJournalBySession(
  store: SessionStore,
  opts: Omit<WorkspaceJournalOptions, "newestFirst">,
): WorkspaceJournalBySessionRecord {
  const journal = buildWorkspaceJournal(store, opts);
  return {
    schema: WORKSPACE_JOURNAL_BY_SESSION_SCHEMA,
    v: WORKSPACE_JOURNAL_BY_SESSION_VERSION,
    workspace: journal.workspace,
    sessionsScanned: journal.sessionsScanned,
    sessionsSkippedArchived: journal.sessionsSkippedArchived,
    bySession: bucketWorkspaceEntriesBySession(journal.entries),
    count: journal.entries.length,
    elided: journal.elided,
    skipped: journal.skipped,
  };
}

export function formatWorkspaceJournalBySession(record: WorkspaceJournalBySessionRecord): string[] {
  const elidedNote = record.elided > 0 ? ` (+${record.elided} older event(s) not shown)` : "";
  const skippedNote = record.skipped > 0 ? ` (+${record.skipped} newer event(s) skipped)` : "";
  if (record.count === 0) {
    return [`0 event(s).${elidedNote}${skippedNote}`];
  }
  const lines = [
    `${record.count} event(s) across ${record.bySession.length} session(s).${elidedNote}${skippedNote}`,
  ];
  for (const b of record.bySession) {
    lines.push(`  ${b.shortId} ×${b.count}`);
  }
  return lines;
}
