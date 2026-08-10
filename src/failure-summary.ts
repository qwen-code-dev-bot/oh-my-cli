// Failure summary: names the failed step and preserves actionable diagnostics
// when a Goal fails.
//
// Derived from GoalRevisionHistory and ExecutionAuditTrail. Finds the last
// error event, identifies the failed step, and suggests actionable next steps
// (retry, edit plan, cancel). Read-only, bounded, and deterministic.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";
import type { GoalRevisionHistory } from "./goal-revision.js";
import type { ExecutionAuditTrail, ExecutionEvent } from "./execution-audit.js";

export const FAILURE_SUMMARY_SCHEMA = "oh-my-cli.failure-summary";
export const FAILURE_SUMMARY_VERSION = 1;

// --- types ------------------------------------------------------------------

export type SuggestedAction = "retry" | "edit-plan" | "cancel" | "investigate";

export interface FailureSummary {
  schema: typeof FAILURE_SUMMARY_SCHEMA;
  v: typeof FAILURE_SUMMARY_VERSION;
  /** The Goal objective that failed. */
  objective: string;
  /** Goal title (if set). */
  title?: string;
  /** The revision that failed. */
  failedRevision: number;
  /** The attempt that failed. */
  failedAttempt: number;
  /** Description of the failed step (from the last error event). */
  failedStepDescription: string;
  /** Error diagnostic (bounded, redacted). */
  diagnostic: string;
  /** When the failure occurred (epoch ms). */
  failedAt: number;
  /** Suggested next actions. */
  suggestedActions: SuggestedAction[];
  /** Total events before the failure. */
  eventsBeforeFailure: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_DIAGNOSTIC_LENGTH = 300;

function safeDiagnostic(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_DIAGNOSTIC_LENGTH
    ? redacted
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_DIAGNOSTIC_LENGTH - 1))}…`;
}

// --- suggestion generation --------------------------------------------------

function suggestActions(hasRetry: boolean, hasPlanSteps: boolean): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  if (hasRetry) {
    actions.push("retry");
  }
  if (hasPlanSteps) {
    actions.push("edit-plan");
  }
  actions.push("investigate");
  actions.push("cancel");

  return actions;
}

// --- summary builder --------------------------------------------------------

// Build a failure summary from revision history and audit trail.
export function buildFailureSummary(
  history: GoalRevisionHistory,
  trail?: ExecutionAuditTrail,
): FailureSummary | null {
  const active = history.getActive();
  if (!active || active.status !== "failed") {
    return null; // Not a failed Goal.
  }

  // Find the last error event from the audit trail.
  let lastError: ExecutionEvent | null = null;
  let eventsBeforeFailure = 0;

  if (trail) {
    const events = trail.getAllEvents();
    for (const event of events) {
      if (event.type === "error") {
        lastError = event;
      }
      if (!lastError) {
        eventsBeforeFailure++;
      }
    }
  }

  const failedStepDescription = lastError
    ? lastError.description
    : "Unknown failure (no error events recorded)";

  const diagnostic = lastError
    ? safeDiagnostic(lastError.description)
    : "No diagnostic information available.";

  const failedAttempt = lastError?.attempt ?? 1;
  const failedAt = lastError?.timestamp ?? active.updatedAt;

  // Check if there were retries and plan steps.
  const hasRetry = trail
    ? trail.getEventsByType("retry").length > 0
    : false;
  const hasPlanSteps = trail
    ? trail.getEventsByType("plan-step").length > 0
    : false;

  return {
    schema: FAILURE_SUMMARY_SCHEMA,
    v: FAILURE_SUMMARY_VERSION,
    objective: active.objective,
    title: active.title,
    failedRevision: history.revision,
    failedAttempt,
    failedStepDescription,
    diagnostic,
    failedAt,
    suggestedActions: suggestActions(hasRetry, hasPlanSteps),
    eventsBeforeFailure,
  };
}

// --- formatting -------------------------------------------------------------

const ACTION_LABELS: Record<SuggestedAction, string> = {
  retry: "↻ Retry the failed step",
  "edit-plan": "✎ Edit the execution plan",
  cancel: "⊘ Cancel the Goal",
  investigate: "🔍 Investigate the error",
};

// Format a failure summary.
export function formatFailureSummary(summary: FailureSummary | null): string {
  if (!summary) {
    return "No failure to summarize (Goal is not in failed state).";
  }

  const lines: string[] = [];
  lines.push("Goal Failure Summary");
  lines.push("═".repeat(50));

  if (summary.title) {
    lines.push(`Title: ${summary.title}`);
  }
  lines.push(`Objective: ${summary.objective}`);
  lines.push(`Failed: rev ${summary.failedRevision}, attempt ${summary.failedAttempt}`);
  lines.push("");
  lines.push(`Failed step: ${summary.failedStepDescription}`);
  lines.push(`Diagnostic: ${summary.diagnostic}`);
  lines.push(`Events before failure: ${summary.eventsBeforeFailure}`);
  lines.push("");
  lines.push("Suggested actions:");
  for (const action of summary.suggestedActions) {
    lines.push(`  ${ACTION_LABELS[action]}`);
  }

  return lines.join("\n");
}
