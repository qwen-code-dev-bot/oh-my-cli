// Execution outline: generates a concise, bounded plan from a multi-step
// Goal objective before execution begins.
//
// Defines an ExecutionOutline model with ordered steps (id, description,
// status, evidence). generateOutline creates an outline from a Goal
// objective using heuristic splitting. isPlanningRequired returns false
// for simple single-step Goals. Outlines are bounded (max 10 steps),
// redacted, and deterministic.

import { redactSecrets } from "./permission-impact.js";

export const EXECUTION_OUTLINE_SCHEMA = "oh-my-cli.execution-outline";
export const EXECUTION_OUTLINE_VERSION = 1;

// --- types ------------------------------------------------------------------

export type StepStatus = "pending" | "in-progress" | "completed" | "failed" | "skipped";

export interface OutlineStep {
  /** Step identifier (1-based). */
  id: number;
  /** Step description. */
  description: string;
  status: StepStatus;
  /** Evidence recorded for this step (when completed/failed). */
  evidence?: string;
}

export interface ExecutionOutline {
  schema: typeof EXECUTION_OUTLINE_SCHEMA;
  v: typeof EXECUTION_OUTLINE_VERSION;
  /** The Goal objective this outline plans for. */
  objective: string;
  /** Ordered steps. */
  steps: OutlineStep[];
  /** Total number of steps. */
  totalSteps: number;
  /** Number of completed steps. */
  completedSteps: number;
  /** Whether the outline was truncated to the max. */
  truncated: boolean;
}

// --- bounds -----------------------------------------------------------------

const MAX_STEPS = 10;
const MAX_STEP_LENGTH = 200;

// --- planning heuristic -----------------------------------------------------

// Determine whether a Goal objective requires planning.
// Simple objectives (no separators, short) bypass planning.
export function isPlanningRequired(objective: string): boolean {
  const safe = safeStepDescription(objective);
  // If the objective contains step separators, it's multi-step.
  const separators = /[,;]|\band\b|\bthen\b|\balso\b/i;
  if (separators.test(safe)) return true;
  // Long objectives are likely multi-step.
  if (safe.length > 120) return true;
  return false;
}

// Sanitize and bound a step description.
export function safeStepDescription(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_STEP_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STEP_LENGTH - 1)}…`;
}

// Generate an execution outline from a Goal objective using heuristic
// splitting on commas, semicolons, "and", "then", "also".
export function generateOutline(objective: string): ExecutionOutline {
  const safe = safeStepDescription(objective);

  if (!isPlanningRequired(safe)) {
    // Single-step: the whole objective is one step.
    return {
      schema: EXECUTION_OUTLINE_SCHEMA,
      v: EXECUTION_OUTLINE_VERSION,
      objective: safe,
      steps: [{ id: 1, description: safe, status: "pending" }],
      totalSteps: 1,
      completedSteps: 0,
      truncated: false,
    };
  }

  // Split on separators.
  const parts = safe
    .split(/[,;]|\s+and\s+|\s+then\s+|\s+also\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const truncated = parts.length > MAX_STEPS;
  const boundedParts = parts.slice(0, MAX_STEPS);

  const steps: OutlineStep[] = boundedParts.map((description, i) => ({
    id: i + 1,
    description: safeStepDescription(description),
    status: "pending" as StepStatus,
  }));

  return {
    schema: EXECUTION_OUTLINE_SCHEMA,
    v: EXECUTION_OUTLINE_VERSION,
    objective: safe,
    steps,
    totalSteps: steps.length,
    completedSteps: 0,
    truncated,
  };
}

// --- step tracking ----------------------------------------------------------

// Update a step's status and optionally record evidence.
export function updateStepStatus(
  outline: ExecutionOutline,
  stepId: number,
  status: StepStatus,
  evidence?: string,
): ExecutionOutline {
  const steps = outline.steps.map((step) => {
    if (step.id !== stepId) return step;
    return {
      ...step,
      status,
      evidence: evidence !== undefined ? safeStepDescription(evidence) : step.evidence,
    };
  });

  const completedSteps = steps.filter((s) => s.status === "completed").length;

  return { ...outline, steps, completedSteps };
}

// --- formatting -------------------------------------------------------------

export function formatOutline(outline: ExecutionOutline): string {
  const lines: string[] = [];
  lines.push("Execution Outline");
  lines.push("═".repeat(50));
  lines.push(`Objective: ${outline.objective}`);
  lines.push(`Steps: ${outline.completedSteps}/${outline.totalSteps} completed${outline.truncated ? " (truncated)" : ""}`);
  lines.push("");

  for (const step of outline.steps) {
    const icon = stepIcon(step.status);
    const evidence = step.evidence ? ` — ${step.evidence}` : "";
    lines.push(`${icon} ${step.id}. ${step.description}${evidence}`);
  }

  lines.push("");
  lines.push("Read-only: no execution performed.");

  return lines.join("\n");
}

function stepIcon(status: StepStatus): string {
  switch (status) {
    case "pending": return "○";
    case "in-progress": return "▶";
    case "completed": return "✓";
    case "failed": return "✗";
    case "skipped": return "→";
  }
}
