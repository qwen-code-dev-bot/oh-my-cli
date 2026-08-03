import { describe, it, expect } from "vitest";
import {
  emptyGoalQueue,
  enqueueGoal,
  promoteNextGoal,
  clearActiveGoal,
  assembleGoalQueueView,
  formatGoalQueue,
  MAX_QUEUED_GOALS,
  GOAL_QUEUE_SCHEMA,
  GOAL_QUEUE_VERSION,
} from "../../src/goal-queue.js";
import type { GoalQueueState } from "../../src/goal-queue.js";

// Behavior-sensitive coverage for the Goal queue contract (Issue #464): the
// one-active invariant, FIFO ordering, promotion semantics, the queue cap,
// objective validation and sanitization, rendering, determinism, and input
// immutability.

const NOW = 3_000_000_000_000;

// --- one-active invariant -----------------------------------------------------

describe("one-active invariant", () => {
  it("refuses promotion while an active Goal is running", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "first", "user", NOW).state;
    const first = promoteNextGoal(state);
    expect(first.promoted).toBe(true);
    // Slot is now occupied; enqueue a second and try to promote.
    state = enqueueGoal(first.state, "second", "user", NOW + 1).state;
    const second = promoteNextGoal(state);
    expect(second.promoted).toBe(false);
    expect(second.reason).toContain("only one active Goal");
    expect(second.state.queue.length).toBe(1);
  });

  it("promotes the next queued Goal after the active slot is freed", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "first", "user", NOW).state;
    state = enqueueGoal(state, "second", "user", NOW + 1).state;
    state = promoteNextGoal(state).state;
    state = clearActiveGoal(state);
    const result = promoteNextGoal(state);
    expect(result.promoted).toBe(true);
    if (result.promoted) {
      expect(result.goal.objective).toBe("second");
      expect(result.state.hasActiveGoal).toBe(true);
      expect(result.state.queue.length).toBe(0);
    }
  });
});

// --- FIFO ordering -------------------------------------------------------------

describe("FIFO ordering", () => {
  it("promotes in enqueue order", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "alpha", "user", NOW).state;
    state = enqueueGoal(state, "beta", "user", NOW + 1).state;
    state = enqueueGoal(state, "gamma", "user", NOW + 2).state;

    const a = promoteNextGoal(state);
    expect(a.promoted).toBe(true);
    expect(a.goal.objective).toBe("alpha");
    const b = promoteNextGoal(clearActiveGoal(a.state));
    expect(b.goal.objective).toBe("beta");
    const c = promoteNextGoal(clearActiveGoal(b.state));
    expect(c.goal.objective).toBe("gamma");
    expect(c.state.queue.length).toBe(0);
  });
});

// --- promotion no-ops -----------------------------------------------------------

describe("promotion no-ops", () => {
  it("does not promote from an empty queue", () => {
    const result = promoteNextGoal(emptyGoalQueue());
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("no queued Goals");
  });
});

// --- cap -------------------------------------------------------------------------

describe("queue cap", () => {
  it("accepts up to the cap and refuses beyond it with an actionable reason", () => {
    let state = emptyGoalQueue();
    for (let i = 0; i < MAX_QUEUED_GOALS; i++) {
      const result = enqueueGoal(state, `goal ${i}`, "user", NOW + i);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(state.queue.length).toBe(MAX_QUEUED_GOALS);
    const overflow = enqueueGoal(state, "one too many", "user", NOW + 99);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.reason).toContain("full");
    }
    expect(overflow.state.queue.length).toBe(MAX_QUEUED_GOALS);
  });
});

// --- objective validation and sanitization --------------------------------------

describe("objective validation and sanitization", () => {
  it("rejects an empty objective", () => {
    const result = enqueueGoal(emptyGoalQueue(), "   ", "user", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no objective");
    }
  });

  it("redacts secret-shaped objectives", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const result = enqueueGoal(emptyGoalQueue(), `deploy with ${token}`, "user", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.queue[0].objective).not.toContain(token);
      expect(result.state.queue[0].objective).toContain("[REDACTED]");
    }
  });

  it("bounds over-long objectives", () => {
    const result = enqueueGoal(emptyGoalQueue(), "x".repeat(800), "user", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.queue[0].objective.length).toBeLessThanOrEqual(500);
      expect(result.state.queue[0].objective.endsWith("…")).toBe(true);
    }
  });

  it("sanitizes the queued-by actor", () => {
    const token = ["ghp", "_", "b".repeat(24)].join("");
    const result = enqueueGoal(emptyGoalQueue(), "objective", `agent ${token}`, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.queue[0].queuedBy).not.toContain(token);
    }
  });
});

// --- view and rendering ------------------------------------------------------------

describe("view and rendering", () => {
  it("reports active slot, counts, and fullness", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "a", "user", NOW).state;
    state = enqueueGoal(state, "b", "user", NOW + 1).state;
    const view = assembleGoalQueueView(state);
    expect(view.hasActiveGoal).toBe(false);
    expect(view.queuedCount).toBe(2);
    expect(view.full).toBe(false);
    expect(view.schema).toBe(GOAL_QUEUE_SCHEMA);
    expect(view.v).toBe(GOAL_QUEUE_VERSION);
  });

  it("renders active slot, queue order, and counts", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "first", "user", NOW).state;
    state = promoteNextGoal(state).state;
    state = enqueueGoal(state, "second", "user", NOW + 1).state;
    const output = formatGoalQueue(assembleGoalQueueView(state));
    expect(output).toContain("Active goal: yes");
    expect(output).toContain("Queued: 1/" + MAX_QUEUED_GOALS);
    expect(output).toContain("1. second (queued by user)");
  });

  it("renders an empty queue explicitly", () => {
    const output = formatGoalQueue(assembleGoalQueueView(emptyGoalQueue()));
    expect(output).toContain("Active goal: no");
    expect(output).toContain("Queued: 0/" + MAX_QUEUED_GOALS);
    expect(output).toContain("(queue empty)");
  });

  it("marks a full queue", () => {
    let state = emptyGoalQueue();
    for (let i = 0; i < MAX_QUEUED_GOALS; i++) {
      state = enqueueGoal(state, `g${i}`, "user", NOW + i).state;
    }
    const output = formatGoalQueue(assembleGoalQueueView(state));
    expect(output).toContain("(full)");
  });

  it("is deterministic", () => {
    let state = emptyGoalQueue();
    state = enqueueGoal(state, "a", "user", NOW).state;
    state = enqueueGoal(state, "b", "user", NOW + 1).state;
    expect(formatGoalQueue(assembleGoalQueueView(state))).toBe(
      formatGoalQueue(assembleGoalQueueView(state)),
    );
  });
});

// --- purity ---------------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input state", () => {
    const state: GoalQueueState = emptyGoalQueue();
    const snapshot = JSON.stringify(state);
    const enqueued = enqueueGoal(state, "x", "user", NOW);
    promoteNextGoal(enqueued.state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
