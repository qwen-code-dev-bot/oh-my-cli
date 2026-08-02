// Effective context view: aggregates the current Goal attempt's context
// for user inspection.
//
// Aggregates loaded files, active constraints, step links, budget usage,
// and compaction survival block status into a unified inspection view.
// Read-only, bounded, and deterministic.

export const EFFECTIVE_CONTEXT_SCHEMA = "oh-my-cli.effective-context";
export const EFFECTIVE_CONTEXT_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface EffectiveContextView {
  schema: typeof EFFECTIVE_CONTEXT_SCHEMA;
  v: typeof EFFECTIVE_CONTEXT_VERSION;
  /** The Goal objective. */
  objective: string;
  /** Current revision and attempt. */
  revision: number;
  attempt: number;
  /** Loaded file paths. */
  loadedFiles: string[];
  /** Active constraint texts. */
  activeConstraints: string[];
  /** Step link counts by step number. */
  stepLinkCounts: Array<{ step: number; linkCount: number }>;
  /** Estimated context budget usage (tokens). */
  estimatedTokens: number;
  /** Context budget limit (tokens). */
  budgetLimit: number;
  /** Budget usage percentage. */
  budgetPct: number;
  /** Whether a compaction survival block is available. */
  hasSurvivalBlock: boolean;
  /** When the view was generated (epoch ms). */
  generatedAt: number;
}

// --- bounds -----------------------------------------------------------------

const MAX_FILES_DISPLAY = 20;
const MAX_CONSTRAINTS_DISPLAY = 10;

// --- view builder -----------------------------------------------------------

export interface EffectiveContextInput {
  objective: string;
  revision: number;
  attempt: number;
  loadedFiles: string[];
  activeConstraints: string[];
  stepLinkCounts: Array<{ step: number; linkCount: number }>;
  estimatedTokens: number;
  budgetLimit: number;
  hasSurvivalBlock: boolean;
}

// Build an effective context view from the current Goal state.
export function buildEffectiveContextView(
  input: EffectiveContextInput,
  generatedAt: number = Date.now(),
): EffectiveContextView {
  const budgetPct = input.budgetLimit > 0
    ? Math.round((input.estimatedTokens / input.budgetLimit) * 100)
    : 0;

  return {
    schema: EFFECTIVE_CONTEXT_SCHEMA,
    v: EFFECTIVE_CONTEXT_VERSION,
    objective: input.objective,
    revision: input.revision,
    attempt: input.attempt,
    loadedFiles: input.loadedFiles.slice(0, MAX_FILES_DISPLAY),
    activeConstraints: input.activeConstraints.slice(0, MAX_CONSTRAINTS_DISPLAY),
    stepLinkCounts: input.stepLinkCounts,
    estimatedTokens: input.estimatedTokens,
    budgetLimit: input.budgetLimit,
    budgetPct,
    hasSurvivalBlock: input.hasSurvivalBlock,
    generatedAt,
  };
}

// --- formatting -------------------------------------------------------------

export function formatEffectiveContextView(view: EffectiveContextView): string {
  const lines: string[] = [];

  lines.push("Effective Context");
  lines.push("═".repeat(50));
  lines.push(`Objective: ${view.objective}`);
  lines.push(`Revision: ${view.revision}  Attempt: ${view.attempt}`);
  lines.push(`Budget: ${view.estimatedTokens}/${view.budgetLimit} tokens (${view.budgetPct}%)`);
  lines.push(`Survival block: ${view.hasSurvivalBlock ? "available" : "none"}`);

  if (view.loadedFiles.length > 0) {
    lines.push("");
    lines.push(`Loaded files (${view.loadedFiles.length}):`);
    for (const file of view.loadedFiles) {
      lines.push(`  📄 ${file}`);
    }
  }

  if (view.activeConstraints.length > 0) {
    lines.push("");
    lines.push(`Active constraints (${view.activeConstraints.length}):`);
    for (const constraint of view.activeConstraints) {
      lines.push(`  · ${constraint}`);
    }
  }

  if (view.stepLinkCounts.length > 0) {
    lines.push("");
    lines.push("Step links:");
    for (const sl of view.stepLinkCounts) {
      lines.push(`  Step ${sl.step}: ${sl.linkCount} links`);
    }
  }

  lines.push("");
  lines.push("Read-only: no context modified.");

  return lines.join("\n");
}
