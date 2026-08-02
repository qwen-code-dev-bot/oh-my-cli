// Cancelled attempt: records the cancellation of an in-progress Goal attempt
// while preserving its transcript and evidence.
//
// When a user cancels an active attempt, the system preserves the attempt's
// event count, marks the cancellation with actor and reason, and allows
// future queries of cancelled attempts. Read-only model layer, bounded,
// redacted, and deterministic.

import { redactSecrets } from "./permission-impact.js";
import type { ExecutionAuditTrail } from "./execution-audit.js";

export const CANCELLED_ATTEMPT_SCHEMA = "oh-my-cli.cancelled-attempt";
export const CANCELLED_ATTEMPT_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface CancelledAttempt {
  schema: typeof CANCELLED_ATTEMPT_SCHEMA;
  v: typeof CANCELLED_ATTEMPT_VERSION;
  /** Goal revision number. */
  goalRevision: number;
  /** Attempt number that was cancelled. */
  attempt: number;
  /** Who cancelled the attempt. */
  cancelledBy: string;
  /** Why the attempt was cancelled (bounded, redacted). */
  reason: string;
  /** Number of events preserved from the audit trail. */
  preservedEventCount: number;
  /** When the cancellation occurred (epoch ms). */
  cancelledAt: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_REASON_LENGTH = 200;

function safeReason(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_REASON_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

// --- cancellation tracker ---------------------------------------------------

export class CancellationTracker {
  private readonly cancelled: CancelledAttempt[] = [];

  /** Cancel an attempt, preserving the event count from the audit trail. */
  cancelAttempt(
    goalRevision: number,
    attempt: number,
    cancelledBy: string,
    reason: string,
    trail?: ExecutionAuditTrail,
    cancelledAt: number = Date.now(),
  ): CancelledAttempt {
    const preservedEventCount = trail
      ? trail.getEventsForAttempt(goalRevision, attempt).length
      : 0;

    const record: CancelledAttempt = {
      schema: CANCELLED_ATTEMPT_SCHEMA,
      v: CANCELLED_ATTEMPT_VERSION,
      goalRevision,
      attempt,
      cancelledBy,
      reason: safeReason(reason),
      preservedEventCount,
      cancelledAt,
    };

    this.cancelled.push(record);
    return { ...record };
  }

  /** Get all cancelled attempts for a revision. */
  getCancelledForRevision(goalRevision: number): CancelledAttempt[] {
    return this.cancelled
      .filter((c) => c.goalRevision === goalRevision)
      .map((c) => ({ ...c }));
  }

  /** Get all cancelled attempts. */
  getAllCancelled(): CancelledAttempt[] {
    return this.cancelled.map((c) => ({ ...c }));
  }

  /** Number of cancelled attempts. */
  get size(): number {
    return this.cancelled.length;
  }
}

// --- formatting -------------------------------------------------------------

export function formatCancelledAttempt(record: CancelledAttempt): string {
  const lines: string[] = [];
  lines.push(`⊘ Cancelled: rev ${record.goalRevision}, attempt ${record.attempt}`);
  lines.push(`  By: ${record.cancelledBy}`);
  lines.push(`  Reason: ${record.reason}`);
  lines.push(`  Preserved events: ${record.preservedEventCount}`);
  return lines.join("\n");
}

export function formatCancellationTracker(tracker: CancellationTracker): string {
  const records = tracker.getAllCancelled();
  const lines: string[] = [];

  lines.push("Cancelled Attempts");
  lines.push("═".repeat(50));
  lines.push(`Total: ${records.length}`);
  lines.push("");

  for (const record of records) {
    lines.push(formatCancelledAttempt(record));
    lines.push("");
  }

  lines.push("Read-only: no execution interrupted.");

  return lines.join("\n");
}
