// Stale-session retention advisory (Issue #626).
//
// Storage hygiene surfaces (dangling images, stale branches) let users see
// what has gone quiet so they can decide what to retire. Sessions support
// archiving (#598) and pinning (#610), but nothing answers "which sessions
// have gone quiet and are candidates for archiving?" This module assembles
// that view from the summaries: candidates are sessions older than a
// threshold (by last activity) that carry neither explicit keep signal —
// pinned or archived sessions older than the threshold are counted as
// protected, never listed as candidates.
//
// Strictly read-only and strictly advisory: the store is never mutated and
// nothing is ever archived by this surface.

import type { SessionStore } from "./session.js";
import { collectSessionSummaries, formatSessionAge } from "./session-summary.js";
import { shortSessionId } from "./session-picker.js";
import { redactSecrets } from "./permission-impact.js";

export const STALE_SESSIONS_SCHEMA = "oh-my-cli.stale-sessions" as const;
export const STALE_SESSIONS_VERSION = 1 as const;
export const STALE_DEFAULT_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StaleSessionCandidate {
  sessionId: string;
  shortId: string;
  /** Redacted user-owned name, or null when unset. */
  name: string | null;
  ageMs: number;
  ageLabel: string;
  messages: number;
  notes: number;
}

export interface StaleSessionsRecord {
  schema: typeof STALE_SESSIONS_SCHEMA;
  v: typeof STALE_SESSIONS_VERSION;
  thresholdDays: number;
  totalSessions: number;
  /** Archive candidates, oldest first. */
  candidates: StaleSessionCandidate[];
  /** Sessions older than the threshold that are pinned (kept by signal). */
  protectedPinned: number;
  /** Sessions older than the threshold that are archived (already retired). */
  protectedArchived: number;
}

export function buildStaleSessionsReport(
  store: SessionStore,
  opts: { thresholdDays?: number; now?: () => number } = {},
): StaleSessionsRecord {
  const thresholdDays = opts.thresholdDays ?? STALE_DEFAULT_DAYS;
  const thresholdMs = thresholdDays * MS_PER_DAY;
  const now = opts.now ?? (() => Date.now());
  const summaries = collectSessionSummaries(store, { now });

  const candidates: StaleSessionCandidate[] = [];
  let protectedPinned = 0;
  let protectedArchived = 0;

  for (const s of summaries) {
    if (s.ageMs < thresholdMs) continue;
    // Archived takes precedence over pinned for the protected accounting, so a
    // session carrying both markers counts exactly once.
    if (s.archived) {
      protectedArchived++;
      continue;
    }
    if (s.pinned) {
      protectedPinned++;
      continue;
    }
    candidates.push({
      sessionId: s.id,
      shortId: shortSessionId(s.id),
      name: s.name !== undefined ? redactSecrets(s.name).text : null,
      ageMs: s.ageMs,
      ageLabel: formatSessionAge(s.ageMs),
      messages: s.messageCount,
      notes: s.noteCount,
    });
  }

  // Oldest first: the quietest session leads the advisory.
  candidates.sort((a, b) => b.ageMs - a.ageMs);

  return {
    schema: STALE_SESSIONS_SCHEMA,
    v: STALE_SESSIONS_VERSION,
    thresholdDays,
    totalSessions: summaries.length,
    candidates,
    protectedPinned,
    protectedArchived,
  };
}

export function formatStaleSessions(record: StaleSessionsRecord): string[] {
  const lines: string[] = [];
  lines.push(`Stale sessions — threshold ${record.thresholdDays} day(s)`);
  lines.push("─".repeat(40));
  lines.push("");
  if (record.candidates.length === 0) {
    lines.push("No stale sessions at this threshold.");
  } else {
    lines.push("Candidates (oldest first):");
    for (const c of record.candidates) {
      const name = c.name !== null ? `  "${c.name}"` : "";
      lines.push(
        `  ${c.shortId}${name}  ·  last active ${c.ageLabel}  ·  ` +
          `${c.messages} msgs  ·  ${c.notes} note${c.notes === 1 ? "" : "s"}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `Protected (older than threshold): ${record.protectedPinned} pinned · ${record.protectedArchived} archived.`,
  );
  lines.push(`${record.totalSessions} session(s) scanned. Advisory only — nothing is archived.`);
  return lines;
}
