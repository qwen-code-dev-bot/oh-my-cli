// Headless read-only Goal inspection (Issue #578, roadmap #270 section 10's
// inspection leg). A session's durable Goal — objective, status, revision,
// timestamps — was only reachable through the TUI `/goal` command; this
// surface renders the exact checkpoint state, redacted, for automation and
// cross-session auditing. Strictly read-only: it reads the goal sidecar and
// nothing else, writes nothing, and grants no control authority (machine
// create/pause/resume/cancel remain later #270 children). A corrupt or absent
// sidecar behaves exactly as store.readGoal does today — the honest no-goal
// state — and corrupt bytes are preserved, never overwritten.

import { redactSecrets } from "./permission-impact.js";
import type { SessionStore } from "./session.js";

export const GOAL_STATUS_SCHEMA = "oh-my-cli.goal-status" as const;
export const GOAL_STATUS_VERSION = 1 as const;

export interface GoalStatusView {
  status: "active" | "paused" | "achieved";
  /** Redacted objective text. */
  objective: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface GoalStatusRecord {
  schema: typeof GOAL_STATUS_SCHEMA;
  v: typeof GOAL_STATUS_VERSION;
  sessionId: string;
  hasGoal: boolean;
  goal: GoalStatusView | null;
}

export function buildGoalStatusRecord(store: SessionStore, sessionId: string): GoalStatusRecord {
  const checkpoint = store.readGoal(sessionId);
  if (!checkpoint.goal) {
    return { schema: GOAL_STATUS_SCHEMA, v: GOAL_STATUS_VERSION, sessionId, hasGoal: false, goal: null };
  }
  const goal = checkpoint.goal;
  return {
    schema: GOAL_STATUS_SCHEMA,
    v: GOAL_STATUS_VERSION,
    sessionId,
    hasGoal: true,
    goal: {
      status: goal.status,
      // Defense in depth: objectives are sanitized at write time (safeObjective);
      // re-redact at render so a hand-edited sidecar never leaks a secret.
      objective: redactSecrets(goal.objective).text,
      createdAt: new Date(goal.createdAt).toISOString(),
      updatedAt: new Date(goal.updatedAt).toISOString(),
      revision: checkpoint.revision,
    },
  };
}

export function formatGoalStatus(record: GoalStatusRecord): string[] {
  const lines: string[] = [];
  lines.push(`Goal status — session ${record.sessionId.slice(0, 8)}`);
  lines.push("─".repeat(40));
  lines.push("");
  if (!record.goal) {
    lines.push("No goal recorded for this session.");
    return lines;
  }
  const g = record.goal;
  lines.push(`status:    ${g.status}`);
  lines.push(`objective: ${g.objective}`);
  lines.push(`set:       ${g.createdAt}`);
  lines.push(`updated:   ${g.updatedAt}`);
  lines.push(`revision:  ${g.revision}`);
  return lines;
}
