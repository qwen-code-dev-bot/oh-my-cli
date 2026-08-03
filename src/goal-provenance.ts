// Goal provenance: preserves the origin class of Goal execution records —
// user instructions, model decisions, tool results, and manual overrides.
//
// Goal execution records mix four fundamentally different sources. Without an
// origin class, an audit trail cannot distinguish what the user instructed,
// what the model decided, what a tool reported, and what a human manually
// overrode. This module assembles provenance records into a chronological,
// counted, deterministic view and surfaces manual overrides distinctly. It is
// pure and read-only: it never mutates audit trails, sessions, or Goal state.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_PROVENANCE_SCHEMA = "oh-my-cli.goal-provenance";
export const GOAL_PROVENANCE_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ProvenanceOrigin =
  | "user-instruction"
  | "model-decision"
  | "tool-result"
  | "manual-override";

/** Fixed ordering for deterministic per-origin rendering. */
export const PROVENANCE_ORIGIN_ORDER: ProvenanceOrigin[] = [
  "user-instruction",
  "model-decision",
  "tool-result",
  "manual-override",
];

export interface ProvenanceRecord {
  origin: ProvenanceOrigin;
  /** Actor associated with the origin (e.g. user, model, tool name). */
  actor: string;
  /** What was instructed, decided, reported, or overridden. */
  detail: string;
  /** When the record occurred (epoch ms). */
  timestamp: number;
  /** Goal revision this record is associated with. */
  goalRevision: number;
  /** Attempt number within the revision. */
  attempt: number;
}

export interface NormalizedProvenanceRecord {
  origin: ProvenanceOrigin;
  /** Redacted, bounded actor identifier. */
  actor: string;
  /** Redacted, bounded detail. */
  detail: string;
  timestamp: number;
  goalRevision: number;
  attempt: number;
}

export interface GoalProvenanceView {
  schema: typeof GOAL_PROVENANCE_SCHEMA;
  v: typeof GOAL_PROVENANCE_VERSION;
  totalRecords: number;
  /** Records ordered chronologically (deterministic tie-break). */
  records: NormalizedProvenanceRecord[];
  /** Record count per origin. */
  counts: Record<ProvenanceOrigin, number>;
  /** Manual overrides, distinct for audit visibility. */
  overrides: NormalizedProvenanceRecord[];
}

// --- normalization ------------------------------------------------------------

const MAX_DETAIL_LENGTH = 300;
const MAX_ACTOR_LENGTH = 100;

function safeText(value: string, maxLength: number): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength - 1)}…`;
}

function normalizeRecord(record: ProvenanceRecord): NormalizedProvenanceRecord {
  return {
    origin: record.origin,
    actor: safeText(record.actor, MAX_ACTOR_LENGTH),
    detail: safeText(record.detail, MAX_DETAIL_LENGTH),
    timestamp: record.timestamp,
    goalRevision: record.goalRevision,
    attempt: record.attempt,
  };
}

// --- assembly -----------------------------------------------------------------

// Assemble provenance records into a chronological, counted view. Details and
// actors are redacted and bounded. Records are ordered by timestamp ascending
// with a deterministic tie-break (origin, detail, actor). Manual overrides are
// extracted into a distinct list while remaining in the ordered records.
export function assembleGoalProvenance(
  records: ProvenanceRecord[],
): GoalProvenanceView {
  const normalized = records.map(normalizeRecord);
  normalized.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      a.origin.localeCompare(b.origin) ||
      a.detail.localeCompare(b.detail) ||
      a.actor.localeCompare(b.actor),
  );

  const counts: Record<ProvenanceOrigin, number> = {
    "user-instruction": 0,
    "model-decision": 0,
    "tool-result": 0,
    "manual-override": 0,
  };
  for (const record of normalized) {
    counts[record.origin] += 1;
  }

  return {
    schema: GOAL_PROVENANCE_SCHEMA,
    v: GOAL_PROVENANCE_VERSION,
    totalRecords: normalized.length,
    records: normalized,
    counts,
    overrides: normalized.filter((record) => record.origin === "manual-override"),
  };
}

// --- formatting -----------------------------------------------------------------

export function formatGoalProvenance(view: GoalProvenanceView): string {
  const lines: string[] = [];
  lines.push(`Goal provenance (${view.schema} v${view.v})`);
  const countParts = PROVENANCE_ORIGIN_ORDER.map(
    (origin) => `${origin}: ${view.counts[origin]}`,
  ).join(", ");
  lines.push(`Records: ${view.totalRecords} (${countParts})`);
  view.records.forEach((record, index) => {
    lines.push(
      `  ${index + 1}. [${record.origin}] ${record.detail} ` +
        `(rev ${record.goalRevision}, attempt ${record.attempt}, actor: ${record.actor})`,
    );
  });
  lines.push(`Manual overrides: ${view.overrides.length}`);
  return lines.join("\n");
}
