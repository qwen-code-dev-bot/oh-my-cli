// Completion summary: produces a structured summary when a Goal reaches a
// terminal state, containing outcome, evidence, duration, step counts, and
// resource estimates.
//
// Derived from GoalRevisionHistory and ExecutionAuditTrail. Read-only,
// bounded, and deterministic.

import type { GoalRevisionHistory, GoalStatus } from "./goal-revision.js";
import type { ExecutionAuditTrail, ExecutionEventType } from "./execution-audit.js";

export const COMPLETION_SUMMARY_SCHEMA = "oh-my-cli.completion-summary";
export const COMPLETION_SUMMARY_VERSION = 1;

// --- types ------------------------------------------------------------------

export type GoalOutcome = "achieved" | "failed" | "cancelled" | "superseded" | "incomplete";

export interface CompletionSummary {
  schema: typeof COMPLETION_SUMMARY_SCHEMA;
  v: typeof COMPLETION_SUMMARY_VERSION;
  /** The Goal objective. */
  objective: string;
  /** The Goal title (if set). */
  title?: string;
  /** Final outcome. */
  outcome: GoalOutcome;
  /** Terminal state of the last revision. */
  terminalState: GoalStatus | null;
  /** Final revision number. */
  finalRevision: number;
  /** Total number of revisions. */
  totalRevisions: number;
  /** Total duration in ms (from first revision to last update). */
  durationMs: number;
  /** Number of execution events recorded. */
  totalEvents: number;
  /** Event counts by type. */
  eventCounts: Partial<Record<ExecutionEventType, number>>;
  /** Estimated tokens consumed. */
  estimatedTokens: number;
  /** Transition actor (who made the final transition). */
  finalActor?: string;
  /** Transition reason (why the final transition was made). */
  finalReason?: string;
}

// --- outcome mapping --------------------------------------------------------

function statusToOutcome(status: GoalStatus | null): GoalOutcome {
  switch (status) {
    case "achieved": return "achieved";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "superseded": return "superseded";
    default: return "incomplete";
  }
}

const OUTCOME_ICONS: Record<GoalOutcome, string> = {
  achieved: "✓",
  failed: "✗",
  cancelled: "⊘",
  superseded: "↗",
  incomplete: "○",
};

const OUTCOME_LABELS: Record<GoalOutcome, string> = {
  achieved: "Achieved",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
  incomplete: "Incomplete",
};

// --- summary builder --------------------------------------------------------

// Rough token estimate per event type.
const TOKEN_ESTIMATES: Partial<Record<ExecutionEventType, number>> = {
  "tool-call": 200,
  "completion": 500,
  "error": 100,
  "plan-step": 50,
  "approval": 50,
  "retry": 100,
  "status-change": 50,
};

// Build a completion summary from revision history and audit trail.
export function buildCompletionSummary(
  history: GoalRevisionHistory,
  trail?: ExecutionAuditTrail,
): CompletionSummary {
  const revisions = history.list();
  const active = history.getActive();
  const lastRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;

  const terminalState = lastRevision ? lastRevision.status : null;
  const outcome = statusToOutcome(terminalState);

  // Duration: from first revision creation to last revision update.
  const firstRevision = revisions.length > 0 ? revisions[0] : null;
  const durationMs = firstRevision && lastRevision
    ? lastRevision.updatedAt - firstRevision.createdAt
    : 0;

  // Event counts from audit trail.
  const eventCounts: Partial<Record<ExecutionEventType, number>> = {};
  let totalEvents = 0;
  let estimatedTokens = 0;

  if (trail) {
    const events = trail.getAllEvents();
    totalEvents = events.length;
    for (const event of events) {
      eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      estimatedTokens += TOKEN_ESTIMATES[event.type] ?? 100;
    }
  }

  return {
    schema: COMPLETION_SUMMARY_SCHEMA,
    v: COMPLETION_SUMMARY_VERSION,
    objective: active?.objective ?? lastRevision?.objective ?? "(no objective)",
    title: active?.title ?? lastRevision?.title,
    outcome,
    terminalState,
    finalRevision: history.revision,
    totalRevisions: revisions.length,
    durationMs,
    totalEvents,
    eventCounts,
    estimatedTokens,
    finalActor: lastRevision?.transitionActor,
    finalReason: lastRevision?.transitionReason,
  };
}

// --- formatting -------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h${remainMinutes}m`;
}

// Format a completion summary.
export function formatCompletionSummary(summary: CompletionSummary): string {
  const lines: string[] = [];
  const icon = OUTCOME_ICONS[summary.outcome];
  const label = OUTCOME_LABELS[summary.outcome];

  lines.push("Goal Completion Summary");
  lines.push("═".repeat(50));

  if (summary.title) {
    lines.push(`Title: ${summary.title}`);
  }
  lines.push(`Objective: ${summary.objective}`);
  lines.push(`Outcome: ${icon} ${label}`);
  lines.push(`Revisions: ${summary.totalRevisions} (final: rev ${summary.finalRevision})`);
  lines.push(`Duration: ${formatDuration(summary.durationMs)}`);

  if (summary.totalEvents > 0) {
    lines.push(`Events: ${summary.totalEvents}`);
    const counts = Object.entries(summary.eventCounts)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");
    lines.push(`  ${counts}`);
    lines.push(`Est. tokens: ~${summary.estimatedTokens}`);
  }

  if (summary.finalActor) {
    lines.push(`Final transition: ${summary.finalActor}${summary.finalReason ? ` — ${summary.finalReason}` : ""}`);
  }

  return lines.join("\n");
}
