// Goal pending-approvals projection: shows the approvals awaiting a decision
// inside the Goal status surface.
//
// When a Goal attempt waits on tool approvals, the Goal status surface should
// say so: how many approvals are pending and, for each, a redacted action
// summary, risk level, waiting time, and stale-head flag. Decided and expired
// entries stay out of the pending view. The projection is pure and read-only:
// it never grants, decides, expires, or mutates any approval.

import type { ApprovalEntry, RiskLevel } from "./approval-inbox.js";
import { redactSecrets } from "./permission-impact.js";

export const GOAL_APPROVALS_SCHEMA = "oh-my-cli.goal-approvals";
export const GOAL_APPROVALS_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface PendingApprovalView {
  /** Stable approval identifier. */
  id: string;
  /** Redacted summary of the action awaiting approval. */
  actionSummary: string;
  riskLevel: RiskLevel;
  /** How long the approval has been waiting, in milliseconds. */
  waitingMs: number;
  /** Whether the head SHA changed since the request. */
  staleHead: boolean;
}

export interface GoalApprovalsView {
  schema: typeof GOAL_APPROVALS_SCHEMA;
  v: typeof GOAL_APPROVALS_VERSION;
  pendingCount: number;
  /** Pending entries ordered oldest first. */
  pending: PendingApprovalView[];
  /** Whether any pending entry has a stale head. */
  hasStaleHead: boolean;
}

// --- collection -------------------------------------------------------------

// Collect the pending approvals for the Goal status surface. Only entries in
// state "pending" are included; approved, rejected, and expired entries are
// excluded. Entries are ordered oldest first (requestedAt ascending, id as a
// deterministic tie-break). Action summaries are redacted through the shared
// redactor before display. Waiting time is clamped at zero.
export function collectGoalPendingApprovals(
  entries: ApprovalEntry[],
  now: number,
): GoalApprovalsView {
  const pending = entries
    .filter((entry) => entry.state === "pending")
    .sort(
      (a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id),
    )
    .map((entry) => ({
      id: entry.id,
      actionSummary: redactSecrets(entry.actionSummary).text,
      riskLevel: entry.riskLevel,
      waitingMs: Math.max(0, now - entry.requestedAt),
      staleHead: entry.staleHead,
    }));

  return {
    schema: GOAL_APPROVALS_SCHEMA,
    v: GOAL_APPROVALS_VERSION,
    pendingCount: pending.length,
    pending,
    hasStaleHead: pending.some((entry) => entry.staleHead),
  };
}

// --- formatting -------------------------------------------------------------

function formatWaiting(ms: number): string {
  // Issue #810: clamp negative elapsed ms (clock skew) to 0, matching activity-render.
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

export function formatGoalApprovals(view: GoalApprovalsView): string {
  if (view.pendingCount === 0) {
    return "Pending approvals: none";
  }
  const lines: string[] = [`Pending approvals: ${view.pendingCount}`];
  for (const entry of view.pending) {
    const stale = entry.staleHead ? ", STALE HEAD" : "";
    lines.push(
      `  - [${entry.riskLevel}] ${entry.actionSummary} (waiting ${formatWaiting(entry.waitingMs)}${stale})`,
    );
  }
  return lines.join("\n");
}

// Compose the rendered Goal status surface with the pending-approvals
// section. Deterministic for identical inputs.
export function renderGoalStatusWithApprovals(
  goalStatusText: string,
  view: GoalApprovalsView,
): string {
  return `${goalStatusText}\n${formatGoalApprovals(view)}`;
}
