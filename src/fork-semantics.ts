// Fork semantics: defines explicit semantics for copying a Goal when a
// session is forked.
//
// Three modes: copy (independent copy), reference (shared state), clean
// (no Goal). Evaluates the fork outcome based on the chosen mode and
// isolation policy. Read-only, deterministic.

import type { GoalIsolationPolicy } from "./session-isolation.js";
import { DEFAULT_ISOLATION_POLICY } from "./session-isolation.js";

export const FORK_SEMANTICS_SCHEMA = "oh-my-cli.fork-semantics";
export const FORK_SEMANTICS_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ForkMode = "copy" | "reference" | "clean";

export type ForkedGoalState = "independent-copy" | "shared-reference" | "no-goal";

export interface ForkDecision {
  schema: typeof FORK_SEMANTICS_SCHEMA;
  v: typeof FORK_SEMANTICS_VERSION;
  /** The chosen fork mode. */
  mode: ForkMode;
  /** Source session ID. */
  sourceSessionId: string;
  /** Forked session ID. */
  forkedSessionId: string;
  /** The resulting Goal state in the forked session. */
  forkedGoalState: ForkedGoalState;
  /** Goal revision at fork time (for copy/reference modes). */
  goalRevision?: number;
  /** Explanation of the fork decision. */
  reason: string;
}

// --- fork semantics evaluation ----------------------------------------------

const MODE_DESCRIPTIONS: Record<ForkMode, string> = {
  copy: "Forked session gets an independent copy of the Goal. Changes in either session do not affect the other.",
  reference: "Forked session shares the same Goal. Changes in either session are visible to both.",
  clean: "Forked session starts with no Goal. The source Goal is unaffected.",
};

const MODE_TO_STATE: Record<ForkMode, ForkedGoalState> = {
  copy: "independent-copy",
  reference: "shared-reference",
  clean: "no-goal",
};

// Evaluate fork semantics for a session fork.
export function evaluateForkSemantics(
  mode: ForkMode,
  sourceSessionId: string,
  forkedSessionId: string,
  goalRevision?: number,
  _policy: GoalIsolationPolicy = DEFAULT_ISOLATION_POLICY,
): ForkDecision {
  const forkedGoalState = MODE_TO_STATE[mode];

  let reason = MODE_DESCRIPTIONS[mode];

  // If the policy disables fork carry-over, override to clean.
  if (!_policy.carryOverOnFork && mode !== "clean") {
    reason = `Policy overrides fork mode: fork carry-over is disabled. Forked session starts clean (requested mode: ${mode}).`;
    return {
      schema: FORK_SEMANTICS_SCHEMA,
      v: FORK_SEMANTICS_VERSION,
      mode: "clean",
      sourceSessionId,
      forkedSessionId,
      forkedGoalState: "no-goal",
      reason,
    };
  }

  return {
    schema: FORK_SEMANTICS_SCHEMA,
    v: FORK_SEMANTICS_VERSION,
    mode,
    sourceSessionId,
    forkedSessionId,
    forkedGoalState,
    goalRevision: mode === "clean" ? undefined : goalRevision,
    reason,
  };
}

// --- formatting -------------------------------------------------------------

export function formatForkDecision(decision: ForkDecision): string {
  const lines: string[] = [];
  const icon = forkIcon(decision.mode);

  lines.push(`Fork Decision: ${icon} ${decision.mode.toUpperCase()}`);
  lines.push(`Source: ${decision.sourceSessionId}`);
  lines.push(`Forked: ${decision.forkedSessionId}`);
  lines.push(`Goal state: ${decision.forkedGoalState}`);
  if (decision.goalRevision !== undefined) {
    lines.push(`Goal revision: ${decision.goalRevision}`);
  }
  lines.push(`Reason: ${decision.reason}`);

  return lines.join("\n");
}

function forkIcon(mode: ForkMode): string {
  switch (mode) {
    case "copy": return "📋";
    case "reference": return "🔗";
    case "clean": return "🧹";
  }
}
