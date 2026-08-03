// Goal queue contract: exactly one active Goal per session, with additional
// Goals held in a bounded FIFO queue.
//
// The Goal runtime models a single Goal per session. This module defines the
// multi-Goal contract: one active Goal slot, plus a bounded FIFO queue of
// queued Goals. Enqueue validates and sanitizes the objective; promotion
// happens only when the active slot is free and never creates a second
// active Goal. The model is pure: every operation returns new state, never
// mutates its inputs, and never touches persistence.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_QUEUE_SCHEMA = "oh-my-cli.goal-queue";
export const GOAL_QUEUE_VERSION = 1;

/** Maximum number of queued Goals per session. */
export const MAX_QUEUED_GOALS = 10;

const MAX_OBJECTIVE_LENGTH = 500;
const MAX_ACTOR_LENGTH = 100;

// --- types ------------------------------------------------------------------

export interface QueuedGoal {
  /** Sanitized, redacted objective. */
  objective: string;
  /** Sanitized, redacted actor who queued the Goal. */
  queuedBy: string;
  /** When the Goal was queued (epoch ms). */
  queuedAt: number;
}

export interface GoalQueueState {
  /** Whether the single active Goal slot is occupied. */
  hasActiveGoal: boolean;
  /** Queued Goals in FIFO order (head is promoted next). */
  queue: QueuedGoal[];
}

export interface GoalQueueView {
  schema: typeof GOAL_QUEUE_SCHEMA;
  v: typeof GOAL_QUEUE_VERSION;
  hasActiveGoal: boolean;
  queuedCount: number;
  queue: QueuedGoal[];
  /** Whether the queue is at capacity. */
  full: boolean;
}

export type EnqueueResult =
  | { ok: true; state: GoalQueueState }
  | { ok: false; state: GoalQueueState; reason: string };

export type PromoteResult =
  | { promoted: true; state: GoalQueueState; goal: QueuedGoal }
  | { promoted: false; state: GoalQueueState; reason: string };

// --- sanitization -----------------------------------------------------------

function safeText(value: string, maxLength: number): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(terminalSafe).text;
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength - 1)}…`;
}

// --- queue operations ---------------------------------------------------------

/** An empty queue with a free active slot. */
export function emptyGoalQueue(): GoalQueueState {
  return { hasActiveGoal: false, queue: [] };
}

// Enqueue a Goal. Validates that the objective is non-empty, sanitizes and
// redacts it, and refuses when the queue is full. Returns new state on
// success or an actionable refusal; never mutates the input.
export function enqueueGoal(
  state: GoalQueueState,
  objective: string,
  queuedBy: string,
  queuedAt: number,
): EnqueueResult {
  const cleaned = safeText(objective, MAX_OBJECTIVE_LENGTH);
  if (!cleaned) {
    return { ok: false, state, reason: "no objective was provided" };
  }
  if (state.queue.length >= MAX_QUEUED_GOALS) {
    return {
      ok: false,
      state,
      reason: `the Goal queue is full (max ${MAX_QUEUED_GOALS}); complete or remove a queued Goal first`,
    };
  }
  return {
    ok: true,
    state: {
      hasActiveGoal: state.hasActiveGoal,
      queue: [
        ...state.queue,
        { objective: cleaned, queuedBy: safeText(queuedBy, MAX_ACTOR_LENGTH), queuedAt },
      ],
    },
  };
}

// Promote the queue head into the active slot. Promotion happens only when
// the active slot is free and the queue is non-empty; it never creates a
// second active Goal. Returns new state plus the promoted Goal, or an
// actionable refusal; never mutates the input.
export function promoteNextGoal(state: GoalQueueState): PromoteResult {
  if (state.hasActiveGoal) {
    return {
      promoted: false,
      state,
      reason: "an active Goal is already running; only one active Goal per session",
    };
  }
  if (state.queue.length === 0) {
    return { promoted: false, state, reason: "no queued Goals to promote" };
  }
  const [head, ...rest] = state.queue;
  return {
    promoted: true,
    state: { hasActiveGoal: true, queue: rest },
    goal: head,
  };
}

// Free the active slot (e.g. when the active Goal reaches a terminal state),
// making the next promotion possible. Returns new state; never mutates input.
export function clearActiveGoal(state: GoalQueueState): GoalQueueState {
  return { hasActiveGoal: false, queue: [...state.queue] };
}

// --- view and formatting -------------------------------------------------------

export function assembleGoalQueueView(state: GoalQueueState): GoalQueueView {
  return {
    schema: GOAL_QUEUE_SCHEMA,
    v: GOAL_QUEUE_VERSION,
    hasActiveGoal: state.hasActiveGoal,
    queuedCount: state.queue.length,
    queue: [...state.queue],
    full: state.queue.length >= MAX_QUEUED_GOALS,
  };
}

export function formatGoalQueue(view: GoalQueueView): string {
  const lines: string[] = [];
  lines.push(`Goal queue (${view.schema} v${view.v})`);
  lines.push(`Active goal: ${view.hasActiveGoal ? "yes" : "no"}`);
  lines.push(`Queued: ${view.queuedCount}/${MAX_QUEUED_GOALS}${view.full ? " (full)" : ""}`);
  if (view.queuedCount === 0) {
    lines.push("  (queue empty)");
  } else {
    view.queue.forEach((goal, index) => {
      lines.push(`  ${index + 1}. ${goal.objective} (queued by ${goal.queuedBy})`);
    });
  }
  return lines.join("\n");
}
