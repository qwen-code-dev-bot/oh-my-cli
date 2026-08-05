// Fleet-wide session transcript health report (Issue #666).
//
// The store computes per-session transcript integrity (ok / partial /
// corrupt) for its read-only surfaces, but nothing answers "which of my
// sessions are damaged?" The storage report (#664) shows size and the
// journal surfaces skip over corruption per-session, yet there is no
// fleet-wide health view.
//
// This module is strictly read-only and diagnostic: it classifies every
// discovered session with the store's existing integrity machinery (never
// re-diagnosing, never healing), rolls the statuses up, and orders sessions
// worst-first. Exit status is not a health signal — a successful report
// exits 0 even when sessions are damaged. Nothing is created, healed, or
// mutated.

import type { SessionStore } from "./session.js";
import { shortSessionId } from "./session-picker.js";

export const SESSION_HEALTH_SCHEMA = "oh-my-cli.session-health" as const;
export const SESSION_HEALTH_VERSION = 1 as const;

export type SessionHealthStatus = "ok" | "partial" | "corrupt";

export interface SessionHealthEntry {
  sessionId: string;
  shortId: string;
  integrity: SessionHealthStatus;
  /** Parseable messages the transcript carries. */
  messageCount: number;
  /** Unparseable lines the transcript carries. */
  badLines: number;
  /** True when the session carries an archived marker. */
  archived: boolean;
}

export interface SessionHealthRecord {
  schema: typeof SESSION_HEALTH_SCHEMA;
  v: typeof SESSION_HEALTH_VERSION;
  sessionCount: number;
  counts: { ok: number; partial: number; corrupt: number };
  /** Worst-first: corrupt, then partial, then ok; sessionId asc within. */
  sessions: SessionHealthEntry[];
}

const SEVERITY: Record<SessionHealthStatus, number> = { corrupt: 0, partial: 1, ok: 2 };

/**
 * Build the fleet-wide transcript health report (Issue #666). Read-only:
 * classifies with the store's existing integrity machinery and never
 * touches the files. Sessions are discovered by their transcript file, so
 * a file that vanishes mid-report is no longer a session by the store's
 * convention and is omitted rather than given a fabricated status.
 */
export function buildSessionHealthReport(store: SessionStore): SessionHealthRecord {
  const sessions: SessionHealthEntry[] = [];
  const counts = { ok: 0, partial: 0, corrupt: 0 };
  for (const id of store.listIds()) {
    const integ = store.integrity(id);
    if (integ.status === "missing") continue;
    counts[integ.status] += 1;
    sessions.push({
      sessionId: id,
      shortId: shortSessionId(id),
      integrity: integ.status,
      messageCount: integ.messageCount,
      badLines: integ.badLines,
      archived: store.readArchived(id) !== null,
    });
  }
  sessions.sort(
    (a, b) =>
      SEVERITY[a.integrity] - SEVERITY[b.integrity] || a.sessionId.localeCompare(b.sessionId),
  );
  return {
    schema: SESSION_HEALTH_SCHEMA,
    v: SESSION_HEALTH_VERSION,
    sessionCount: sessions.length,
    counts,
    sessions,
  };
}

export function formatSessionHealthReport(record: SessionHealthRecord): string[] {
  const lines: string[] = [];
  lines.push("Session health report");
  lines.push("─".repeat(40));
  lines.push("");
  const { ok, partial, corrupt } = record.counts;
  if (record.sessionCount === 0) {
    lines.push("0 session(s): 0 ok, 0 partial, 0 corrupt.");
    return lines;
  }
  lines.push(`${record.sessionCount} session(s): ${ok} ok, ${partial} partial, ${corrupt} corrupt.`);
  lines.push("");
  for (const s of record.sessions) {
    const archivedNote = s.archived ? " (archived)" : "";
    const detail =
      s.integrity === "ok"
        ? ""
        : ` (${s.badLines} bad line(s), ${s.messageCount} message(s) parseable)`;
    lines.push(`  ${s.shortId}${archivedNote} — ${s.integrity}${detail}`);
  }
  return lines;
}
