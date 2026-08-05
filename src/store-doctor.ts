// Consolidated store checkup (Issue #670).
//
// The store has three separate read-only diagnostics — transcript + sidecar
// health (#666/#668), storage footprint (#664), and stale-session retention
// candidates (#626) — but answering "is my store healthy overall?" means
// running all three and cross-referencing them by hand. Trusted tools offer
// a single consolidated checkup (doctor-style); this module composes the
// existing machineries into one sectioned summary with an overall verdict.
//
// Strictly read-only and diagnostic: it reuses the three report builders
// verbatim (never re-implementing them), derives the verdict honestly from
// the findings, and exits successfully regardless of findings — the checkup
// is a report, not a failure signal. Nothing is created, healed, archived,
// or mutated.

import type { SessionStore } from "./session.js";
import { buildSessionHealthReport } from "./session-health.js";
import type { SessionHealthRecord } from "./session-health.js";
import { buildSessionStorageReport } from "./session-storage.js";
import type { SessionStorageRecord } from "./session-storage.js";
import { buildStaleSessionsReport, STALE_DEFAULT_DAYS } from "./stale-sessions.js";
import { formatBytes } from "./artifact-retention.js";

export const STORE_DOCTOR_SCHEMA = "oh-my-cli.store-doctor" as const;
export const STORE_DOCTOR_VERSION = 1 as const;

export type StoreDoctorVerdict = "healthy" | "attention-needed";

export interface StoreDoctorStaleSection {
  thresholdDays: number;
  /** Archive candidates (pinned and archived sessions are exempt). */
  candidates: number;
  /** Older-than-threshold sessions kept because they are pinned. */
  protectedPinned: number;
  /** Older-than-threshold sessions already archived. */
  protectedArchived: number;
}

export interface StoreDoctorRecord {
  schema: typeof STORE_DOCTOR_SCHEMA;
  v: typeof STORE_DOCTOR_VERSION;
  /** Transcript + sidecar health section (the full #666/#668 report). */
  health: SessionHealthRecord;
  /** Storage footprint section (the full #664 report). */
  storage: SessionStorageRecord;
  /** Stale-session section (rollups of the #626 report, default threshold). */
  stale: StoreDoctorStaleSection;
  verdict: StoreDoctorVerdict;
  /** Contributing findings when the verdict is attention-needed. */
  reasons: string[];
}

/**
 * Build the consolidated store checkup (Issue #670) by composing the
 * existing diagnostic machineries. Read-only. The verdict is derived
 * honestly: healthy only with no corrupt transcripts, no damaged sidecars,
 * and no stale candidates; otherwise attention-needed with every
 * contributing finding listed. Partial transcripts are recoverable trailing
 * tears and do not affect the verdict.
 */
export function buildStoreDoctorReport(
  store: SessionStore,
  opts: { now?: () => number } = {},
): StoreDoctorRecord {
  const health = buildSessionHealthReport(store);
  const storage = buildSessionStorageReport(store);
  const stale = buildStaleSessionsReport(store, {
    thresholdDays: STALE_DEFAULT_DAYS,
    now: opts.now,
  });

  const reasons: string[] = [];
  if (health.counts.corrupt > 0) {
    reasons.push(`${health.counts.corrupt} corrupt transcript(s)`);
  }
  if (health.sessionsWithDamagedSidecars > 0) {
    reasons.push(`${health.sessionsWithDamagedSidecars} session(s) with damaged sidecar file(s)`);
  }
  if (stale.candidates.length > 0) {
    reasons.push(
      `${stale.candidates.length} stale session(s) older than ${stale.thresholdDays} days (archive candidates)`,
    );
  }

  return {
    schema: STORE_DOCTOR_SCHEMA,
    v: STORE_DOCTOR_VERSION,
    health,
    storage,
    stale: {
      thresholdDays: stale.thresholdDays,
      candidates: stale.candidates.length,
      protectedPinned: stale.protectedPinned,
      protectedArchived: stale.protectedArchived,
    },
    verdict: reasons.length === 0 ? "healthy" : "attention-needed",
    reasons,
  };
}

export function formatStoreDoctorReport(record: StoreDoctorRecord): string[] {
  const lines: string[] = [];
  lines.push("Store doctor");
  lines.push("─".repeat(40));
  lines.push("");
  const { ok, partial, corrupt } = record.health.counts;
  lines.push(
    `Sessions: ${record.health.sessionCount} total — ${ok} ok, ${partial} partial, ${corrupt} corrupt.`,
  );
  lines.push(
    `Sidecars: ${record.health.sessionsWithDamagedSidecars} session(s) with damaged sidecar file(s).`,
  );
  if (record.storage.sessionCount === 0) {
    lines.push("Storage: 0B across 0 session(s).");
  } else {
    const largest = record.storage.sessions[0];
    lines.push(
      `Storage: ${formatBytes(record.storage.totalBytes)} across ${record.storage.sessionCount} session(s); ` +
        `largest ${largest.shortId} (${formatBytes(largest.bytes)}).`,
    );
  }
  lines.push(
    `Stale: ${record.stale.candidates} archive candidate(s) older than ${record.stale.thresholdDays} days ` +
      `(${record.stale.protectedPinned} pinned, ${record.stale.protectedArchived} archived protected).`,
  );
  lines.push("");
  if (record.verdict === "healthy") {
    lines.push("Verdict: healthy.");
  } else {
    lines.push(`Verdict: attention needed — ${record.reasons.join("; ")}.`);
  }
  return lines;
}
