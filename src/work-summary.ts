// Work summary: summarizes completed work and remaining constraints for
// context continuity after compaction.
//
// Derives from ExecutionOutline and GoalConstraintTracker. Captures
// completed steps, remaining steps, and active constraints in a compact
// form. Bounded, redacted, and deterministic.

import type { ExecutionOutline, OutlineStep } from "./execution-outline.js";
import type { GoalConstraintTracker } from "./goal-constraints.js";

export const WORK_SUMMARY_SCHEMA = "oh-my-cli.work-summary";
export const WORK_SUMMARY_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface WorkSummary {
  schema: typeof WORK_SUMMARY_SCHEMA;
  v: typeof WORK_SUMMARY_VERSION;
  /** The Goal objective. */
  objective: string;
  /** Completed steps (status: completed or skipped). */
  completedSteps: Array<{ description: string; evidence?: string }>;
  /** Remaining steps (status: pending or in-progress). */
  remainingSteps: Array<{ description: string; status: string }>;
  /** Active constraints. */
  activeConstraints: string[];
  /** When the summary was generated (epoch ms). */
  generatedAt: number;
  /** Progress percentage. */
  progressPct: number;
}

// --- summary builder --------------------------------------------------------

// Build a work summary from an execution outline and constraints.
export function buildWorkSummary(
  outline: ExecutionOutline,
  constraints?: GoalConstraintTracker,
  generatedAt: number = Date.now(),
): WorkSummary {
  const completedSteps: Array<{ description: string; evidence?: string }> = [];
  const remainingSteps: Array<{ description: string; status: string }> = [];

  for (const step of outline.steps) {
    if (step.status === "completed" || step.status === "skipped") {
      completedSteps.push({
        description: step.description,
        evidence: step.evidence,
      });
    } else {
      remainingSteps.push({
        description: step.description,
        status: step.status,
      });
    }
  }

  const activeConstraints = constraints
    ? constraints.getConstraints().map((c) => c.text)
    : [];

  const totalSteps = outline.steps.length;
  const progressPct = totalSteps > 0
    ? Math.round((completedSteps.length / totalSteps) * 100)
    : 0;

  return {
    schema: WORK_SUMMARY_SCHEMA,
    v: WORK_SUMMARY_VERSION,
    objective: outline.objective,
    completedSteps,
    remainingSteps,
    activeConstraints,
    generatedAt,
    progressPct,
  };
}

// --- formatting -------------------------------------------------------------

// Format a work summary as a compact summary suitable for context injection.
export function formatWorkSummary(summary: WorkSummary): string {
  const lines: string[] = [];

  lines.push("Work Summary");
  lines.push("═".repeat(50));
  lines.push(`Objective: ${summary.objective}`);
  lines.push(`Progress: ${summary.progressPct}% (${summary.completedSteps.length}/${summary.completedSteps.length + summary.remainingSteps.length} steps)`);

  if (summary.completedSteps.length > 0) {
    lines.push("");
    lines.push("Completed:");
    for (const step of summary.completedSteps) {
      const evidence = step.evidence ? ` — ${step.evidence}` : "";
      lines.push(`  ✓ ${step.description}${evidence}`);
    }
  }

  if (summary.remainingSteps.length > 0) {
    lines.push("");
    lines.push("Remaining:");
    for (const step of summary.remainingSteps) {
      const icon = step.status === "in-progress" ? "▶" : "○";
      lines.push(`  ${icon} ${step.description} [${step.status}]`);
    }
  }

  if (summary.activeConstraints.length > 0) {
    lines.push("");
    lines.push("Active constraints:");
    for (const constraint of summary.activeConstraints) {
      lines.push(`  · ${constraint}`);
    }
  }

  return lines.join("\n");
}
