// Archive-stale executor (Issue #702): the retention story's action half.
// The stale-sessions report (#626, strict-gated by #680) detects archive
// candidates; this surface acts on exactly those candidates.
//
// Dry run is the default: resolve the same candidates the stale-sessions
// report shows and print them with a trailing note, mutating nothing.
// --apply opts into the mutation, and the mutation is bounded by design:
// archiving writes the existing archived marker (via the same primitive as
// --archive-session), never deletes, never touches transcripts or any
// other sidecar, and is reversible with --unarchive-session. Pinned and
// already-archived sessions are protected by the builder and never become
// candidates, so they can never be re-archived here either.

import type { SessionStore } from "./session.js";
import {
  buildStaleSessionsReport,
  type StaleSessionsRecord,
} from "./stale-sessions.js";
import { archiveSession } from "./session-archive.js";

export const ARCHIVE_STALE_SCHEMA = "oh-my-cli.archive-stale" as const;
export const ARCHIVE_STALE_VERSION = 1 as const;

export type ArchiveStaleMode = "dry-run" | "apply";

/** Versioned machine-readable record of an archive-stale run (Issue #702). */
export interface ArchiveStaleRecord {
  schema: typeof ARCHIVE_STALE_SCHEMA;
  v: typeof ARCHIVE_STALE_VERSION;
  thresholdDays: number;
  mode: ArchiveStaleMode;
  /** Sessions resolved as archive candidates, oldest first. */
  candidates: Array<{ sessionId: string; shortId: string }>;
  /** Session ids archived by this run; empty in dry-run mode. */
  archivedIds: string[];
  protectedPinned: number;
  protectedArchived: number;
}

export interface ArchiveStaleOutcome {
  /** The resolved stale report — reused verbatim for the dry-run text. */
  report: StaleSessionsRecord;
  record: ArchiveStaleRecord;
}

/**
 * Execute an archive-stale run (Issue #702). In dry-run mode the store is
 * never touched; in apply mode exactly the resolved candidates receive the
 * archived marker via the shared archiveSession primitive (idempotent —
 * a session that is already archived is reported as such, never rewritten).
 */
export function executeArchiveStale(
  store: SessionStore,
  opts: { thresholdDays: number; apply: boolean },
): ArchiveStaleOutcome {
  const report = buildStaleSessionsReport(store, { thresholdDays: opts.thresholdDays });
  const candidates = report.candidates.map((c) => ({
    sessionId: c.sessionId,
    shortId: c.shortId,
  }));
  const archivedIds: string[] = [];
  if (opts.apply) {
    for (const candidate of candidates) {
      const result = archiveSession(store, candidate.sessionId);
      if (result.ok && !result.alreadyArchived) {
        archivedIds.push(candidate.sessionId);
      }
    }
  }
  return {
    report,
    record: {
      schema: ARCHIVE_STALE_SCHEMA,
      v: ARCHIVE_STALE_VERSION,
      thresholdDays: opts.thresholdDays,
      mode: opts.apply ? "apply" : "dry-run",
      candidates,
      archivedIds,
      protectedPinned: report.protectedPinned,
      protectedArchived: report.protectedArchived,
    },
  };
}

/**
 * Render the apply-mode result as lines (Issue #702). Dry-run text is the
 * stale-sessions report itself plus a trailing note (rendered by the
 * caller), so its "Advisory only — nothing is archived" footer stays true.
 */
export function formatArchiveStale(record: ArchiveStaleRecord): string[] {
  const lines: string[] = [];
  lines.push(`Archive stale sessions — threshold ${record.thresholdDays} day(s)`);
  lines.push("─".repeat(40));
  lines.push("");
  if (record.candidates.length === 0) {
    lines.push("No stale archive candidates at this threshold.");
  } else {
    lines.push("Archived:");
    for (const candidate of record.candidates) {
      lines.push(`  ${candidate.shortId}`);
    }
  }
  lines.push(
    `Protected (older than threshold): ${record.protectedPinned} pinned · ${record.protectedArchived} archived.`,
  );
  lines.push("");
  lines.push(
    `Archived ${record.archivedIds.length} session(s). Nothing was deleted; restore any with --unarchive-session ${record.candidates.length > 0 ? record.candidates[0].shortId : "<id>"}.`,
  );
  return lines;
}

/** The trailing note appended to the dry-run rendering (Issue #702). */
export const ARCHIVE_STALE_DRY_RUN_NOTE =
  "Dry run: nothing archived (re-run with --apply to archive the sessions above).";
