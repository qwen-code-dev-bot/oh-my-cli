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
import { buildSessionJournalEntries } from "./session-journal.js";
import { applyJournalSkip, filterEntriesByKind, filterEntriesByWindow } from "./session-journal.js";
import type { JournalOrder, JournalTimeWindow, SessionJournalKind } from "./session-journal.js";

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

export function formatWorkspaceJournal(record: WorkspaceJournalRecord): string[] {
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
      `  ${new Date(e.at).toISOString()} · ${e.shortId}${verdict} · ${e.kind} · ${e.detail}`,
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
