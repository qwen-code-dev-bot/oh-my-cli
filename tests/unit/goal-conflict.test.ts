import { describe, it, expect } from "vitest";
import {
  emptyGoalConflictState,
  acquireMutationLock,
  releaseMutationLock,
  lockHolder,
  assembleGoalConflictView,
  formatGoalConflictView,
  GOAL_CONFLICT_SCHEMA,
  GOAL_CONFLICT_VERSION,
} from "../../src/goal-conflict.js";

// Behavior-sensitive coverage for Goal workspace conflict controls (Issue
// #473): acquire on free workspaces, re-entrancy, concurrent refusal naming
// the holder, holder-only release, multi-workspace independence, held
// duration, empty placeholder, determinism, and input immutability.

const NOW = 8_000_000_000_000;

// --- acquire ------------------------------------------------------------------

describe("acquire", () => {
  it("grants the lock on a free workspace", () => {
    const result = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW);
    expect(result.ok).toBe(true);
    expect(lockHolder(result.state, "ws-a")).toBe("goal-1");
  });

  it("is re-entrant for the holding Goal without double-locking", () => {
    let state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const again = acquireMutationLock(state, "ws-a", "goal-1", NOW + 5000);
    expect(again.ok).toBe(true);
    expect(again.state.locks.length).toBe(1);
    // The original acquisition time is preserved.
    expect(again.state.locks[0].acquiredAt).toBe(NOW);
  });

  it("refuses a concurrent acquire by another Goal and names the holder", () => {
    const state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const result = acquireMutationLock(state, "ws-a", "goal-2", NOW + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("goal-1");
    }
    expect(lockHolder(result.state, "ws-a")).toBe("goal-1");
  });
});

// --- release ------------------------------------------------------------------

describe("release", () => {
  it("releases when the holder asks, freeing the workspace for re-acquire", () => {
    let state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const released = releaseMutationLock(state, "ws-a", "goal-1");
    expect(released.ok).toBe(true);
    expect(lockHolder(released.state, "ws-a")).toBeNull();
    const reacquired = acquireMutationLock(released.state, "ws-a", "goal-2", NOW + 10);
    expect(reacquired.ok).toBe(true);
    expect(lockHolder(reacquired.state, "ws-a")).toBe("goal-2");
  });

  it("refuses a non-holder release", () => {
    const state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const result = releaseMutationLock(state, "ws-a", "goal-2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("goal-1");
    }
    expect(lockHolder(result.state, "ws-a")).toBe("goal-1");
  });

  it("refuses to release an unlocked workspace", () => {
    const result = releaseMutationLock(emptyGoalConflictState(), "ws-a", "goal-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not locked");
    }
  });
});

// --- multi-workspace independence ------------------------------------------------

describe("multi-workspace independence", () => {
  it("lets different Goals hold different workspaces", () => {
    let state = emptyGoalConflictState();
    state = acquireMutationLock(state, "ws-a", "goal-1", NOW).state;
    const second = acquireMutationLock(state, "ws-b", "goal-2", NOW + 1);
    expect(second.ok).toBe(true);
    expect(lockHolder(second.state, "ws-a")).toBe("goal-1");
    expect(lockHolder(second.state, "ws-b")).toBe("goal-2");
    expect(second.state.locks.length).toBe(2);
  });
});

// --- view and rendering --------------------------------------------------------------

describe("view and rendering", () => {
  it("computes held duration from the supplied now", () => {
    let state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const view = assembleGoalConflictView(state, NOW + 125_000);
    expect(view.lockCount).toBe(1);
    expect(view.locks[0].heldMs).toBe(125_000);
    expect(view.schema).toBe(GOAL_CONFLICT_SCHEMA);
    expect(view.v).toBe(GOAL_CONFLICT_VERSION);

    const output = formatGoalConflictView(view);
    expect(output).toContain("Locked workspaces: 1");
    expect(output).toContain("workspace ws-a held by Goal goal-1 (held 2m 5s)");
  });

  it("clamps held duration at zero for future-dated locks", () => {
    const state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW + 10_000).state;
    const view = assembleGoalConflictView(state, NOW);
    expect(view.locks[0].heldMs).toBe(0);
  });

  it("renders an explicit placeholder when nothing is locked", () => {
    const output = formatGoalConflictView(assembleGoalConflictView(emptyGoalConflictState(), NOW));
    expect(output).toContain("Locked workspaces: 0");
    expect(output).toContain("(no locked workspaces)");
  });

  it("is deterministic", () => {
    const state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    expect(formatGoalConflictView(assembleGoalConflictView(state, NOW + 1000))).toBe(
      formatGoalConflictView(assembleGoalConflictView(state, NOW + 1000)),
    );
  });
});

// --- purity ------------------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input state", () => {
    const state = acquireMutationLock(emptyGoalConflictState(), "ws-a", "goal-1", NOW).state;
    const snapshot = JSON.stringify(state);
    acquireMutationLock(state, "ws-a", "goal-2", NOW + 1);
    releaseMutationLock(state, "ws-a", "goal-1");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
