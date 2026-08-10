// Step progress view: derives a compact progress summary from an
// ExecutionOutline showing current step, completed/pending/blocked/skipped
// counts, and overall progress percentage.
//
// Progress is a read-only view derived from the outline (no separate
// state). Deterministic and surface-independent.

import type { ExecutionOutline, OutlineStep, StepStatus } from "./execution-outline.js";

export const STEP_PROGRESS_SCHEMA = "oh-my-cli.step-progress";
export const STEP_PROGRESS_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface StepProgress {
  schema: typeof STEP_PROGRESS_SCHEMA;
  v: typeof STEP_PROGRESS_VERSION;
  /** The current step (first in-progress), or null if none. */
  currentStep: OutlineStep | null;
  /** Number of completed steps. */
  completed: number;
  /** Number of pending steps. */
  pending: number;
  /** Number of in-progress steps. */
  inProgress: number;
  /** Number of failed (blocked) steps. */
  blocked: number;
  /** Number of skipped steps. */
  skipped: number;
  /** Total steps. */
  total: number;
  /** Progress percentage (0-100). */
  progressPct: number;
  /** Whether all steps are done (completed or skipped). */
  isDone: boolean;
  /** Whether any step is blocked (failed). */
  hasBlocked: boolean;
}

// --- derivation -------------------------------------------------------------

// Derive step progress from an execution outline.
export function deriveStepProgress(outline: ExecutionOutline): StepProgress {
  const counts: Record<StepStatus, number> = {
    "pending": 0,
    "in-progress": 0,
    "completed": 0,
    "failed": 0,
    "skipped": 0,
  };

  let currentStep: OutlineStep | null = null;

  for (const step of outline.steps) {
    counts[step.status]++;
    if (step.status === "in-progress" && currentStep === null) {
      currentStep = step;
    }
  }

  const total = outline.steps.length;
  const done = counts["completed"] + counts["skipped"];
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    schema: STEP_PROGRESS_SCHEMA,
    v: STEP_PROGRESS_VERSION,
    currentStep,
    completed: counts["completed"],
    pending: counts["pending"],
    inProgress: counts["in-progress"],
    blocked: counts["failed"],
    skipped: counts["skipped"],
    total,
    progressPct,
    isDone: done === total,
    hasBlocked: counts["failed"] > 0,
  };
}

// --- formatting -------------------------------------------------------------

const BAR_WIDTH = 20;

// Render a compact progress bar.
export function renderProgressBar(pct: number): string {
  // Issue #808: clamp the fill into [0, BAR_WIDTH] so an out-of-range pct
  // (over-100 or negative) renders a clamped bar instead of throwing a
  // RangeError from a negative repeat count. In-range output is unchanged.
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
  const empty = BAR_WIDTH - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

// Format step progress as a compact summary.
export function formatStepProgress(progress: StepProgress): string {
  const lines: string[] = [];
  const bar = renderProgressBar(progress.progressPct);

  lines.push(`Progress: ${bar} ${progress.progressPct}%`);
  lines.push(`Steps: ${progress.completed}✓ ${progress.inProgress}▶ ${progress.pending}○ ${progress.blocked}✗ ${progress.skipped}→ / ${progress.total}`);

  if (progress.currentStep) {
    lines.push(`Current: ${progress.currentStep.id}. ${progress.currentStep.description}`);
  }

  if (progress.hasBlocked) {
    lines.push("⚠ Blocked steps detected");
  }

  if (progress.isDone) {
    lines.push("✓ All steps complete");
  }

  return lines.join("\n");
}
