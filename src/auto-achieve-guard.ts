// Auto-achieve guard: prevents auto-achieve after provider failure,
// interruption, cancellation, budget exhaustion, or stale revision.
//
// Evaluates whether auto-achieve is safe given the execution outcome.
// Read-only evaluation, deterministic.

export const AUTO_ACHIEVE_GUARD_SCHEMA = "oh-my-cli.auto-achieve-guard";
export const AUTO_ACHIEVE_GUARD_VERSION = 1;

// --- types ------------------------------------------------------------------

export type AchieveBlocker =
  | "provider-failure"
  | "interruption"
  | "cancellation"
  | "budget-exhausted"
  | "stale-revision";

export type ExecutionOutcome =
  | "success"
  | "provider-failure"
  | "interrupted"
  | "cancelled"
  | "budget-exhausted"
  | "stale-revision";

export interface AchieveGuardEvaluation {
  schema: typeof AUTO_ACHIEVE_GUARD_SCHEMA;
  v: typeof AUTO_ACHIEVE_GUARD_VERSION;
  /** Whether auto-achieve is safe. */
  safe: boolean;
  /** The execution outcome being evaluated. */
  outcome: ExecutionOutcome;
  /** The blocker (when not safe). */
  blocker?: AchieveBlocker;
  /** Explanation of the guard decision. */
  reason: string;
}

// --- outcome to blocker mapping ---------------------------------------------

const OUTCOME_TO_BLOCKER: Partial<Record<ExecutionOutcome, AchieveBlocker>> = {
  "provider-failure": "provider-failure",
  "interrupted": "interruption",
  "cancelled": "cancellation",
  "budget-exhausted": "budget-exhausted",
  "stale-revision": "stale-revision",
};

const BLOCKER_REASONS: Record<AchieveBlocker, string> = {
  "provider-failure": "Provider failed. Auto-achieve blocked: execution did not complete successfully.",
  "interruption": "Execution was interrupted. Auto-achieve blocked: execution did not complete.",
  "cancellation": "Execution was cancelled. Auto-achieve blocked: execution was explicitly stopped.",
  "budget-exhausted": "Budget exhausted. Auto-achieve blocked: execution stopped at budget limit.",
  "stale-revision": "Stale revision. Auto-achieve blocked: Goal was revised during execution.",
};

// --- guard evaluation -------------------------------------------------------

// Evaluate whether auto-achieve is safe given the execution outcome.
export function evaluateAutoAchieve(outcome: ExecutionOutcome): AchieveGuardEvaluation {
  if (outcome === "success") {
    return {
      schema: AUTO_ACHIEVE_GUARD_SCHEMA,
      v: AUTO_ACHIEVE_GUARD_VERSION,
      safe: true,
      outcome,
      reason: "Execution completed successfully. Auto-achieve is safe.",
    };
  }

  const blocker = OUTCOME_TO_BLOCKER[outcome];
  if (!blocker) {
    return {
      schema: AUTO_ACHIEVE_GUARD_SCHEMA,
      v: AUTO_ACHIEVE_GUARD_VERSION,
      safe: false,
      outcome,
      reason: `Unknown outcome "${outcome}". Auto-achieve blocked by default.`,
    };
  }

  return {
    schema: AUTO_ACHIEVE_GUARD_SCHEMA,
    v: AUTO_ACHIEVE_GUARD_VERSION,
    safe: false,
    outcome,
    blocker,
    reason: BLOCKER_REASONS[blocker],
  };
}

// --- formatting -------------------------------------------------------------

export function formatAchieveGuardStatus(evaluation: AchieveGuardEvaluation): string {
  const icon = evaluation.safe ? "✓" : "⊘";
  const status = evaluation.safe ? "SAFE" : "BLOCKED";

  const lines: string[] = [];
  lines.push(`Auto-Achieve Guard: ${icon} ${status}`);
  lines.push(`Outcome: ${evaluation.outcome}`);
  if (evaluation.blocker) {
    lines.push(`Blocker: ${evaluation.blocker}`);
  }
  lines.push(`Reason: ${evaluation.reason}`);

  return lines.join("\n");
}
