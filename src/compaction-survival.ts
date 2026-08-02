// Compaction survival block: bundles the Goal objective, work summary, and
// pinned constraints into a compact block that survives context compaction.
//
// After compaction, the agent's context includes this block, ensuring
// continuity without re-discovery. Bounded (max 2000 chars), redacted,
// and deterministic.

import type { WorkSummary } from "./work-summary.js";

export const COMPACTION_SURVIVAL_SCHEMA = "oh-my-cli.compaction-survival";
export const COMPACTION_SURVIVAL_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface CompactionSurvivalBlock {
  schema: typeof COMPACTION_SURVIVAL_SCHEMA;
  v: typeof COMPACTION_SURVIVAL_VERSION;
  /** The Goal objective. */
  objective: string;
  /** Progress percentage. */
  progressPct: number;
  /** Completed step descriptions. */
  completedSteps: string[];
  /** Remaining step descriptions. */
  remainingSteps: string[];
  /** Pinned constraint texts. */
  pinnedConstraints: string[];
  /** When the block was generated (epoch ms). */
  generatedAt: number;
  /** Total character length of the formatted block. */
  charCount: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_BLOCK_CHARS = 2000;
const MAX_STEP_DISPLAY = 80;
const MAX_CONSTRAINT_DISPLAY = 100;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// --- block builder ----------------------------------------------------------

// Build a compaction survival block from a work summary and pinned constraints.
export function buildSurvivalBlock(
  summary: WorkSummary,
  pinnedConstraints: string[] = [],
  generatedAt: number = Date.now(),
): CompactionSurvivalBlock {
  const completedSteps = summary.completedSteps.map(
    (s) => truncate(s.description, MAX_STEP_DISPLAY),
  );
  const remainingSteps = summary.remainingSteps.map(
    (s) => truncate(s.description, MAX_STEP_DISPLAY),
  );
  const constraints = pinnedConstraints.map(
    (c) => truncate(c, MAX_CONSTRAINT_DISPLAY),
  );

  const block: CompactionSurvivalBlock = {
    schema: COMPACTION_SURVIVAL_SCHEMA,
    v: COMPACTION_SURVIVAL_VERSION,
    objective: truncate(summary.objective, 200),
    progressPct: summary.progressPct,
    completedSteps,
    remainingSteps,
    pinnedConstraints: constraints,
    generatedAt,
    charCount: 0, // Computed after formatting.
  };

  const formatted = formatSurvivalBlock(block);
  block.charCount = formatted.length;

  return block;
}

// --- formatting -------------------------------------------------------------

// Format a compaction survival block as a compact block suitable for
// context injection. Bounded to MAX_BLOCK_CHARS.
export function formatSurvivalBlock(block: CompactionSurvivalBlock): string {
  const lines: string[] = [];

  lines.push("[GOAL CONTEXT]");
  lines.push(`Objective: ${block.objective}`);
  lines.push(`Progress: ${block.progressPct}%`);

  if (block.completedSteps.length > 0) {
    lines.push(`Done: ${block.completedSteps.join("; ")}`);
  }

  if (block.remainingSteps.length > 0) {
    lines.push(`Todo: ${block.remainingSteps.join("; ")}`);
  }

  if (block.pinnedConstraints.length > 0) {
    lines.push(`Constraints: ${block.pinnedConstraints.join("; ")}`);
  }

  lines.push("[/GOAL CONTEXT]");

  let output = lines.join("\n");

  // Enforce max block size.
  if (output.length > MAX_BLOCK_CHARS) {
    output = output.slice(0, MAX_BLOCK_CHARS - 20) + "\n… [truncated]\n[/GOAL CONTEXT]";
  }

  return output;
}
