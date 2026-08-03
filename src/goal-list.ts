// Goal list projection: unifies the current Goal (active or paused), queued
// Goals, and recently completed Goals into one deterministic list view.
//
// With the multi-Goal contract defined (src/goal-queue.ts), users need a
// single surface showing active, queued, paused, and recently completed items
// together. This projection assembles that view: at most one current Goal,
// queued Goals in FIFO order, and a bounded newest-first set of completed
// Goals with outcome markers. Objectives are sanitized and redacted. The
// projection is pure and read-only: it never mutates its inputs and never
// touches persistence.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_LIST_SCHEMA = "oh-my-cli.goal-list";
export const GOAL_LIST_VERSION = 1;

/** How many recently completed Goals to keep in the list. */
export const MAX_RECENT_COMPLETED = 10;

const MAX_OBJECTIVE_LENGTH = 500;

// --- types ------------------------------------------------------------------

export type GoalCurrentStatus = "active" | "paused";
export type GoalOutcome = "achieved" | "failed" | "cancelled";
export type GoalListState = "active" | "paused" | "queued" | "completed";

export interface GoalListInput {
  /** The current Goal (active or paused), at most one. */
  current: {
    objective: string;
    status: GoalCurrentStatus;
    revision: number;
    updatedAt: number;
  } | null;
  /** Queued Goals in FIFO order. */
  queued: { objective: string; queuedAt: number }[];
  /** Recently completed Goals (any order; sorted newest first). */
  completed: {
    objective: string;
    outcome: GoalOutcome;
    revision: number;
    updatedAt: number;
  }[];
}

export interface GoalListEntry {
  /** Sanitized, redacted objective. */
  objective: string;
  state: GoalListState;
  /** Terminal outcome for completed entries. */
  outcome?: GoalOutcome;
  /** Goal revision, when applicable. */
  revision?: number;
  updatedAt: number;
}

export interface GoalListView {
  schema: typeof GOAL_LIST_SCHEMA;
  v: typeof GOAL_LIST_VERSION;
  total: number;
  counts: { active: number; paused: number; queued: number; completed: number };
  current: GoalListEntry | null;
  queued: GoalListEntry[];
  completed: GoalListEntry[];
}

// --- sanitization -----------------------------------------------------------

function safeObjective(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= MAX_OBJECTIVE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_OBJECTIVE_LENGTH - 1)}…`;
}

// --- assembly ------------------------------------------------------------------

// Assemble the unified Goal list. The current Goal (if any) comes first, then
// queued Goals in FIFO order, then completed Goals bounded to the recent cap
// and ordered newest first. Objectives are sanitized and redacted. Never
// mutates the input.
export function assembleGoalList(input: GoalListInput): GoalListView {
  const current: GoalListEntry | null = input.current
    ? {
        objective: safeObjective(input.current.objective),
        state: input.current.status,
        revision: input.current.revision,
        updatedAt: input.current.updatedAt,
      }
    : null;

  const queued: GoalListEntry[] = input.queued.map((goal) => ({
    objective: safeObjective(goal.objective),
    state: "queued",
    updatedAt: goal.queuedAt,
  }));

  const completed: GoalListEntry[] = [...input.completed]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECENT_COMPLETED)
    .map((goal) => ({
      objective: safeObjective(goal.objective),
      state: "completed",
      outcome: goal.outcome,
      revision: goal.revision,
      updatedAt: goal.updatedAt,
    }));

  return {
    schema: GOAL_LIST_SCHEMA,
    v: GOAL_LIST_VERSION,
    total: (current ? 1 : 0) + queued.length + completed.length,
    counts: {
      active: current?.state === "active" ? 1 : 0,
      paused: current?.state === "paused" ? 1 : 0,
      queued: queued.length,
      completed: completed.length,
    },
    current,
    queued,
    completed,
  };
}

// --- formatting ------------------------------------------------------------------

export function formatGoalList(view: GoalListView): string {
  const lines: string[] = [];
  lines.push(`Goals (${view.schema} v${view.v})`);

  if (view.current === null) {
    lines.push("Current: (none)");
  } else if (view.current.state === "active") {
    lines.push(`Active: ${view.current.objective}`);
  } else {
    lines.push(`Paused: ${view.current.objective}`);
  }

  lines.push(`Queued: ${view.counts.queued}`);
  if (view.queued.length === 0) {
    lines.push("  (none queued)");
  } else {
    view.queued.forEach((goal, index) => {
      lines.push(`  ${index + 1}. ${goal.objective}`);
    });
  }

  lines.push(`Recently completed: ${view.counts.completed}`);
  if (view.completed.length === 0) {
    lines.push("  (none completed)");
  } else {
    for (const goal of view.completed) {
      lines.push(`  - [${goal.outcome}] ${goal.objective}`);
    }
  }

  return lines.join("\n");
}
