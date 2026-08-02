// Session isolation: prevents Goal state from leaking into unrelated
// resumed or forked sessions.
//
// Defines isolation policy and session-Goal binding. Evaluates whether
// Goal state should carry over on resume/fork or be isolated. Read-only
// evaluation, deterministic.

export const SESSION_ISOLATION_SCHEMA = "oh-my-cli.session-isolation";
export const SESSION_ISOLATION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type SessionAction = "resume" | "fork";

export interface GoalIsolationPolicy {
  /** Whether Goal state carries over on resume. */
  carryOverOnResume: boolean;
  /** Whether Goal state carries over on fork. */
  carryOverOnFork: boolean;
  /** Maximum age (ms) for Goal state to be considered fresh on resume. */
  maxStalenessMs: number;
}

export interface SessionGoalBinding {
  /** Session ID the Goal is bound to. */
  sessionId: string;
  /** Goal revision at binding time. */
  goalRevision: number;
  /** When the binding was created (epoch ms). */
  boundAt: number;
  /** Whether the binding is stale (Goal state is older than maxStaleness). */
  isStale: boolean;
}

export interface IsolationEvaluation {
  schema: typeof SESSION_ISOLATION_SCHEMA;
  v: typeof SESSION_ISOLATION_VERSION;
  /** The session action being evaluated. */
  action: SessionAction;
  /** Whether Goal state should carry over. */
  carryOver: boolean;
  /** The binding being evaluated. */
  binding: SessionGoalBinding;
  /** Reason for the isolation decision. */
  reason: string;
}

// --- default policy ---------------------------------------------------------

export const DEFAULT_ISOLATION_POLICY: GoalIsolationPolicy = {
  carryOverOnResume: true,
  carryOverOnFork: false,
  maxStalenessMs: 3_600_000, // 1 hour
};

// --- isolation evaluation ---------------------------------------------------

// Evaluate whether Goal state should carry over on resume/fork.
export function evaluateIsolation(
  binding: SessionGoalBinding,
  action: SessionAction,
  policy: GoalIsolationPolicy = DEFAULT_ISOLATION_POLICY,
  now: number = Date.now(),
): IsolationEvaluation {
  const ageMs = now - binding.boundAt;
  const isStale = ageMs > policy.maxStalenessMs;

  // Update binding staleness.
  const evaluatedBinding: SessionGoalBinding = { ...binding, isStale };

  let carryOver: boolean;
  let reason: string;

  if (action === "resume") {
    if (!policy.carryOverOnResume) {
      carryOver = false;
      reason = "Policy: Goal state does not carry over on resume.";
    } else if (isStale) {
      carryOver = false;
      reason = `Goal state is stale (${Math.floor(ageMs / 60000)}m old, max ${Math.floor(policy.maxStalenessMs / 60000)}m). Isolated to prevent stale context.`;
    } else {
      carryOver = true;
      reason = `Goal state is fresh (${Math.floor(ageMs / 60000)}m old). Carrying over on resume.`;
    }
  } else {
    // fork
    if (!policy.carryOverOnFork) {
      carryOver = false;
      reason = "Policy: Goal state does not carry over on fork. Forked sessions start clean.";
    } else if (isStale) {
      carryOver = false;
      reason = `Goal state is stale (${Math.floor(ageMs / 60000)}m old). Isolated on fork.`;
    } else {
      carryOver = true;
      reason = `Goal state is fresh. Carrying over on fork.`;
    }
  }

  return {
    schema: SESSION_ISOLATION_SCHEMA,
    v: SESSION_ISOLATION_VERSION,
    action,
    carryOver,
    binding: evaluatedBinding,
    reason,
  };
}

// --- formatting -------------------------------------------------------------

export function formatIsolationStatus(evaluation: IsolationEvaluation): string {
  const lines: string[] = [];
  const icon = evaluation.carryOver ? "✓" : "⊘";

  lines.push(`Session Isolation: ${icon} ${evaluation.carryOver ? "CARRY OVER" : "ISOLATED"}`);
  lines.push(`Action: ${evaluation.action}`);
  lines.push(`Session: ${evaluation.binding.sessionId}`);
  lines.push(`Goal revision: ${evaluation.binding.goalRevision}`);
  lines.push(`Stale: ${evaluation.binding.isStale ? "yes" : "no"}`);
  lines.push(`Reason: ${evaluation.reason}`);

  return lines.join("\n");
}
