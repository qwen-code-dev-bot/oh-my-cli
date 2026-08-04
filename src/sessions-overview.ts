// Aggregate session-store health (Issue #604).
//
// Every session surface is per-session or enumerating; none aggregates.
// This module renders one bounded, read-only census of the whole store:
// integrity verdicts (exact, never healed), sidecar-presence counts, a
// bounded workspace breakdown, and a recency pointer — so humans and
// automation can answer "what state is everything in?" with a single read.
//
// Strictly read-only: it reads through the existing diagnostics/sidecar
// readers and writes nothing — no heals, no quarantine, no markers. Presence
// definitions match the sibling surfaces: archived/named/goal reflect valid
// sidecar state (as in --inspect-session); notes reflect ledger existence.

import fs from "node:fs";
import type { SessionStore } from "./session.js";
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets, redactHomePath } from "./permission-impact.js";
import { notesPath } from "./session-notes.js";

export const SESSIONS_OVERVIEW_SCHEMA = "oh-my-cli.sessions-overview" as const;
export const SESSIONS_OVERVIEW_VERSION = 1 as const;
/** Workspace groups kept in the breakdown before elision. */
export const OVERVIEW_WORKSPACE_MAX = 10;

export interface SessionsOverviewTotals {
  sessions: number;
  ok: number;
  partial: number;
  corrupt: number;
}

export interface SessionsOverviewMetadata {
  archived: number;
  named: number;
  withGoal: number;
  withNotes: number;
  /** Sessions pinned to the top of discovery (Issue #610). */
  pinned: number;
}

export interface SessionsOverviewWorkspace {
  /** Redacted, home-collapsed workspace path. */
  workspace: string;
  sessions: number;
}

export interface SessionsOverviewRecord {
  schema: typeof SESSIONS_OVERVIEW_SCHEMA;
  v: typeof SESSIONS_OVERVIEW_VERSION;
  totals: SessionsOverviewTotals;
  metadata: SessionsOverviewMetadata;
  /** Top workspaces by session count (bounded), redacted. */
  workspaces: SessionsOverviewWorkspace[];
  /** Workspace groups dropped by the bound. */
  workspacesElided: number;
  /** Sessions without workspace metadata (never grouped). */
  legacyNoWorkspace: number;
  /** Most recently modified session, or null for an empty store. */
  newest: { sessionId: string; shortId: string; ageMs: number } | null;
}

export function buildSessionsOverviewRecord(
  store: SessionStore,
  now: number = Date.now(),
): SessionsOverviewRecord {
  const summaries = collectSessionSummaries(store, { now: () => now });

  const totals: SessionsOverviewTotals = { sessions: summaries.length, ok: 0, partial: 0, corrupt: 0 };
  const metadata: SessionsOverviewMetadata = { archived: 0, named: 0, withGoal: 0, withNotes: 0, pinned: 0 };
  const byWorkspace = new Map<string, number>();
  let legacyNoWorkspace = 0;

  for (const s of summaries) {
    const status = store.integrity(s.id).status;
    if (status === "corrupt") totals.corrupt++;
    else if (status === "partial") totals.partial++;
    else totals.ok++;

    if (store.readArchived(s.id) !== null) metadata.archived++;
    if (store.readName(s.id) !== null) metadata.named++;
    if (store.readGoal(s.id).goal !== null) metadata.withGoal++;
    if (fs.existsSync(notesPath(store, s.id))) metadata.withNotes++;
    if (s.pinned) metadata.pinned++;

    if (s.workspace === undefined || s.workspace === "") {
      legacyNoWorkspace++;
    } else {
      byWorkspace.set(s.workspace, (byWorkspace.get(s.workspace) ?? 0) + 1);
    }
  }

  // Deterministic order: session count descending, then path ascending.
  const groups = [...byWorkspace.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const workspaces = groups.slice(0, OVERVIEW_WORKSPACE_MAX).map(([workspace, sessions]) => ({
    workspace: redactSecrets(redactHomePath(workspace)).text,
    sessions,
  }));

  const newestSummary = summaries[0];
  return {
    schema: SESSIONS_OVERVIEW_SCHEMA,
    v: SESSIONS_OVERVIEW_VERSION,
    totals,
    metadata,
    workspaces,
    workspacesElided: Math.max(0, groups.length - OVERVIEW_WORKSPACE_MAX),
    legacyNoWorkspace,
    newest:
      newestSummary !== undefined
        ? {
            sessionId: newestSummary.id,
            shortId: shortSessionId(newestSummary.id),
            ageMs: newestSummary.ageMs,
          }
        : null,
  };
}

export function formatSessionsOverview(record: SessionsOverviewRecord): string[] {
  const lines: string[] = [];
  lines.push("Sessions overview");
  lines.push("─".repeat(40));
  lines.push("");
  const t = record.totals;
  lines.push(`total:      ${t.sessions} session(s)`);
  if (t.sessions === 0) {
    lines.push("");
    lines.push("No sessions in the store.");
    return lines;
  }
  lines.push(`integrity:  ${t.ok} ok · ${t.partial} partial · ${t.corrupt} corrupt`);
  const m = record.metadata;
  lines.push(
    `metadata:   ${m.archived} archived · ${m.named} named · ${m.withGoal} with goal · ${m.withNotes} with notes · ${m.pinned} pinned`,
  );
  const groupTotal = record.workspaces.length + record.workspacesElided;
  lines.push(`workspaces: ${groupTotal} group(s)` + (record.workspacesElided > 0 ? ` (top ${OVERVIEW_WORKSPACE_MAX})` : ""));
  for (const w of record.workspaces) {
    lines.push(`  ${w.sessions} · ${w.workspace}`);
  }
  if (record.workspacesElided > 0) {
    lines.push(`  (+${record.workspacesElided} workspace group(s) not shown)`);
  }
  if (record.legacyNoWorkspace > 0) {
    lines.push(`  legacy (no workspace): ${record.legacyNoWorkspace}`);
  }
  if (record.newest !== null) {
    lines.push(`newest:     ${record.newest.shortId} · last active ${formatSessionAge(record.newest.ageMs)}`);
  }
  return lines;
}
