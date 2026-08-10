// Plan approval gate: allows users to approve, reject, or edit a proposed
// execution plan before costly or risky execution begins.
//
// Defines a PlanApproval model with approval state (pending, approved,
// rejected, edited). requestApproval creates an approval request from an
// ExecutionOutline. approvePlan/rejectPlan record the decision. editStep
// modifies a step description before approval. Approval state is bounded,
// redacted, and deterministic.

import { redactSecrets } from "./permission-impact.js";
import { safeCutEnd } from "./text-cut.js";
import type { ExecutionOutline } from "./execution-outline.js";
import { safeStepDescription } from "./execution-outline.js";

export const PLAN_APPROVAL_SCHEMA = "oh-my-cli.plan-approval";
export const PLAN_APPROVAL_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ApprovalState = "pending" | "approved" | "rejected" | "edited";

export interface PlanApproval {
  schema: typeof PLAN_APPROVAL_SCHEMA;
  v: typeof PLAN_APPROVAL_VERSION;
  /** The outline this approval is for. */
  objective: string;
  /** Number of steps in the plan. */
  stepCount: number;
  /** Current approval state. */
  state: ApprovalState;
  /** Who made the approval decision. */
  decidedBy?: string;
  /** When the decision was made (epoch ms). */
  decidedAt?: number;
  /** Reason for rejection (when rejected). */
  rejectionReason?: string;
  /** Whether any steps were edited before approval. */
  wasEdited: boolean;
  /** Step descriptions (may have been edited). */
  stepDescriptions: string[];
}

// --- approval operations ----------------------------------------------------

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
    : `${redacted.slice(0, safeCutEnd(redacted, MAX_REASON_LENGTH - 1))}…`;
}

// Create an approval request from an execution outline.
export function requestApproval(outline: ExecutionOutline): PlanApproval {
  return {
    schema: PLAN_APPROVAL_SCHEMA,
    v: PLAN_APPROVAL_VERSION,
    objective: outline.objective,
    stepCount: outline.totalSteps,
    state: "pending",
    wasEdited: false,
    stepDescriptions: outline.steps.map((s) => s.description),
  };
}

// Approve the plan.
export function approvePlan(
  approval: PlanApproval,
  actor: string = "user",
  now: number = Date.now(),
): PlanApproval {
  if (approval.state !== "pending" && approval.state !== "edited") {
    return approval; // Already decided.
  }
  return {
    ...approval,
    state: "approved",
    decidedBy: actor,
    decidedAt: now,
  };
}

// Reject the plan with a reason.
export function rejectPlan(
  approval: PlanApproval,
  reason: string,
  actor: string = "user",
  now: number = Date.now(),
): PlanApproval {
  if (approval.state !== "pending" && approval.state !== "edited") {
    return approval; // Already decided.
  }
  return {
    ...approval,
    state: "rejected",
    decidedBy: actor,
    decidedAt: now,
    rejectionReason: safeReason(reason),
  };
}

// Edit a step description before approval.
export function editStep(
  approval: PlanApproval,
  stepIndex: number,
  newDescription: string,
): PlanApproval {
  if (approval.state !== "pending" && approval.state !== "edited") {
    return approval; // Already decided.
  }
  if (stepIndex < 0 || stepIndex >= approval.stepDescriptions.length) {
    return approval; // Invalid index.
  }

  const descriptions = [...approval.stepDescriptions];
  descriptions[stepIndex] = safeStepDescription(newDescription);

  return {
    ...approval,
    state: "edited",
    wasEdited: true,
    stepDescriptions: descriptions,
  };
}

// --- formatting -------------------------------------------------------------

export function formatPlanApproval(approval: PlanApproval): string {
  const lines: string[] = [];
  const icon = approvalIcon(approval.state);

  lines.push(`Plan Approval: ${icon} ${approval.state.toUpperCase()}`);
  lines.push("─".repeat(40));
  lines.push(`Objective: ${approval.objective}`);
  lines.push(`Steps: ${approval.stepCount}${approval.wasEdited ? " (edited)" : ""}`);

  for (let i = 0; i < approval.stepDescriptions.length; i++) {
    lines.push(`  ${i + 1}. ${approval.stepDescriptions[i]}`);
  }

  if (approval.decidedBy) {
    lines.push("");
    lines.push(`Decision: ${approval.state} by ${approval.decidedBy}`);
    if (approval.rejectionReason) {
      lines.push(`Reason: ${approval.rejectionReason}`);
    }
  }

  return lines.join("\n");
}

function approvalIcon(state: ApprovalState): string {
  switch (state) {
    case "pending": return "○";
    case "approved": return "✓";
    case "rejected": return "✗";
    case "edited": return "✎";
  }
}
