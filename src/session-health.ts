// Fleet-wide session transcript health report (Issue #666), extended with
// sidecar-level diagnostics (Issue #668).
//
// The store computes per-session transcript integrity (ok / partial /
// corrupt) for its read-only surfaces, but nothing answers "which of my
// sessions are damaged?" The storage report (#664) shows size and the
// journal surfaces skip over corruption per-session, yet there is no
// fleet-wide health view. And transcript integrity alone misses the
// sidecars: a session whose transcript is healthy but whose goal, notes,
// pinned, name, or archived sidecar is damaged JSON still reported ok.
//
// This module is strictly read-only and diagnostic: it classifies every
// discovered session with the store's existing integrity machinery (never
// re-diagnosing, never healing), checks the JSON parseability of each
// present sidecar, rolls the statuses up, and orders sessions worst-first.
// Exit status is not a health signal — a successful report exits 0 even
// when sessions are damaged, unless `--strict` (Issue #678) maps the
// damage findings to exit code 1 for automation. Nothing is created,
// healed, quarantined, or mutated.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { notesPath } from "./session-notes.js";
import { shortSessionId } from "./session-picker.js";

export const SESSION_HEALTH_SCHEMA = "oh-my-cli.session-health" as const;
export const SESSION_HEALTH_VERSION = 1 as const;

export type SessionHealthStatus = "ok" | "partial" | "corrupt";

/** Sidecar diagnostics scope (Issue #668), in fixed canonical order. */
export const SIDECAR_NAMES = ["name", "goal", "notes", "pinned", "archived"] as const;

export type SidecarName = (typeof SIDECAR_NAMES)[number];

function sidecarPath(store: SessionStore, id: string, name: SidecarName): string {
  switch (name) {
    case "name":
      return store.namePath(id);
    case "goal":
      return store.goalPath(id);
    case "notes":
      return notesPath(store, id);
    case "pinned":
      return store.pinnedPath(id);
    case "archived":
      return store.archivedPath(id);
  }
}

/**
 * Check every present sidecar of a session for JSON parseability
 * (Issue #668). Absent sidecars are normal (many sessions have no
 * goal/notes/pin/archive) and never reported. Read-only: files are read,
 * never rewritten. Returns damaged names in fixed canonical order.
 */
export function damagedSidecars(store: SessionStore, id: string): SidecarName[] {
  const damaged: SidecarName[] = [];
  for (const name of SIDECAR_NAMES) {
    const p = sidecarPath(store, id, name);
    if (!fs.existsSync(p)) continue;
    try {
      JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      damaged.push(name);
    }
  }
  return damaged;
}

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
  /** Present-but-unparseable sidecars, canonical order (Issue #668). */
  damagedSidecars: SidecarName[];
}

export interface SessionHealthRecord {
  schema: typeof SESSION_HEALTH_SCHEMA;
  v: typeof SESSION_HEALTH_VERSION;
  sessionCount: number;
  counts: { ok: number; partial: number; corrupt: number };
  /** Sessions with at least one damaged sidecar (Issue #668). */
  sessionsWithDamagedSidecars: number;
  /**
   * Worst-first: transcript severity (corrupt, partial, ok), then
   * damaged-sidecar count descending, then sessionId ascending.
   */
  sessions: SessionHealthEntry[];
}

const SEVERITY: Record<SessionHealthStatus, number> = { corrupt: 0, partial: 1, ok: 2 };

/**
 * Build the fleet-wide health report (Issue #666, sidecar diagnostics
 * #668). Read-only: classifies transcripts with the store's existing
 * integrity machinery and checks sidecar parseability, never touching the
 * files. Sessions are discovered by their transcript file, so a file that
 * vanishes mid-report is no longer a session by the store's convention and
 * is omitted rather than given a fabricated status.
 */
export function buildSessionHealthReport(store: SessionStore): SessionHealthRecord {
  const sessions: SessionHealthEntry[] = [];
  const counts = { ok: 0, partial: 0, corrupt: 0 };
  let sessionsWithDamagedSidecars = 0;
  for (const id of store.listIds()) {
    const integ = store.integrity(id);
    if (integ.status === "missing") continue;
    counts[integ.status] += 1;
    const damaged = damagedSidecars(store, id);
    if (damaged.length > 0) sessionsWithDamagedSidecars += 1;
    sessions.push({
      sessionId: id,
      shortId: shortSessionId(id),
      integrity: integ.status,
      messageCount: integ.messageCount,
      badLines: integ.badLines,
      archived: store.readArchived(id) !== null,
      damagedSidecars: damaged,
    });
  }
  sessions.sort(
    (a, b) =>
      SEVERITY[a.integrity] - SEVERITY[b.integrity] ||
      b.damagedSidecars.length - a.damagedSidecars.length ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return {
    schema: SESSION_HEALTH_SCHEMA,
    v: SESSION_HEALTH_VERSION,
    sessionCount: sessions.length,
    counts,
    sessionsWithDamagedSidecars,
    sessions,
  };
}

/**
 * Map a health report to the `--strict` exit code (Issue #678): 1 when
 * any transcript is corrupt or any session carries a damaged sidecar,
 * 0 otherwise — partial transcripts alone are recoverable trailing tears
 * and never fail. Pure; output is unaffected — the exit code is the
 * machine-readable signal.
 */
export function healthReportStrictExit(record: SessionHealthRecord): number {
  return record.counts.corrupt > 0 || record.sessionsWithDamagedSidecars > 0 ? 1 : 0;
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
  if (record.sessionsWithDamagedSidecars > 0) {
    lines.push(
      `${record.sessionsWithDamagedSidecars} session(s) with damaged sidecar file(s).`,
    );
  }
  lines.push("");
  for (const s of record.sessions) {
    const archivedNote = s.archived ? " (archived)" : "";
    const parts: string[] = [];
    if (s.integrity !== "ok") {
      parts.push(`${s.badLines} bad line(s), ${s.messageCount} message(s) parseable`);
    }
    if (s.damagedSidecars.length > 0) {
      parts.push(`damaged sidecars: ${s.damagedSidecars.join(", ")}`);
    }
    const detail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
    lines.push(`  ${s.shortId}${archivedNote} — ${s.integrity}${detail}`);
  }
  return lines;
}
