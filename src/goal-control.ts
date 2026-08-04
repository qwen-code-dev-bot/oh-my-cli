// Headless Goal control (Issue #582, roadmap #270 section 10's control leg;
// inspection delivered by #578/#580). Automation could inspect a session's
// Goal headlessly but not control it; this surface runs the exact
// runGoalCommand semantics (set / pause / resume / achieve / clear / status)
// against a resolved session's durable Goal checkpoint, preserving the #580
// append-only history. Goal control is session-state mutation, not workspace
// or tool authority: it reuses runGoalCommand's guards exactly and never
// touches tool approvals or sandbox boundaries.

import type { SessionStore } from "./session.js";
import { runGoalCommand } from "./session-goal.js";
import { buildGoalStatusRecord } from "./goal-status.js";
import type { GoalStatusRecord } from "./goal-status.js";

export const GOAL_CONTROL_SCHEMA = "oh-my-cli.goal-control" as const;
export const GOAL_CONTROL_VERSION = 1 as const;

export interface GoalControlRecord {
  schema: typeof GOAL_CONTROL_SCHEMA;
  v: typeof GOAL_CONTROL_VERSION;
  sessionId: string;
  /** Exact runGoalCommand output (sanitized/redacted there). */
  output: string;
  /** Post-transition checkpoint state. */
  checkpoint: GoalStatusRecord;
}

export function runGoalControl(
  store: SessionStore,
  sessionId: string,
  args: string,
  now: number = Date.now(),
): GoalControlRecord {
  const output = runGoalCommand(store, sessionId, args, now);
  return {
    schema: GOAL_CONTROL_SCHEMA,
    v: GOAL_CONTROL_VERSION,
    sessionId,
    output,
    checkpoint: buildGoalStatusRecord(store, sessionId),
  };
}
