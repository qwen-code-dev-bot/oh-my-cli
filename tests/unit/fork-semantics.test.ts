import { describe, it, expect } from "vitest";
import {
  evaluateForkSemantics,
  formatForkDecision,
  type ForkMode,
} from "../../src/fork-semantics.js";
import type { GoalIsolationPolicy } from "../../src/session-isolation.js";

// Pure-function coverage for fork semantics (Issue #444): fork semantics
// evaluation, mode determination, and determinism.

// Policy that allows fork carry-over (for testing copy/reference modes).
const FORK_ALLOWED_POLICY: GoalIsolationPolicy = {
  carryOverOnResume: true,
  carryOverOnFork: true,
  maxStalenessMs: 3_600_000,
};

// --- copy mode --------------------------------------------------------------

describe("copy mode", () => {
  it("creates independent copy", () => {
    const decision = evaluateForkSemantics("copy", "session-1", "session-2", 3, FORK_ALLOWED_POLICY);

    expect(decision.mode).toBe("copy");
    expect(decision.forkedGoalState).toBe("independent-copy");
    expect(decision.goalRevision).toBe(3);
    expect(decision.sourceSessionId).toBe("session-1");
    expect(decision.forkedSessionId).toBe("session-2");
    expect(decision.reason).toContain("independent copy");
  });
});

// --- reference mode ---------------------------------------------------------

describe("reference mode", () => {
  it("creates shared reference", () => {
    const decision = evaluateForkSemantics("reference", "session-1", "session-2", 2, FORK_ALLOWED_POLICY);

    expect(decision.mode).toBe("reference");
    expect(decision.forkedGoalState).toBe("shared-reference");
    expect(decision.goalRevision).toBe(2);
    expect(decision.reason).toContain("shares the same Goal");
  });
});

// --- clean mode -------------------------------------------------------------

describe("clean mode", () => {
  it("creates clean fork with no Goal", () => {
    const decision = evaluateForkSemantics("clean", "session-1", "session-2", 5);

    expect(decision.mode).toBe("clean");
    expect(decision.forkedGoalState).toBe("no-goal");
    expect(decision.goalRevision).toBeUndefined();
    expect(decision.reason).toContain("no Goal");
  });
});

// --- policy override --------------------------------------------------------

describe("policy override", () => {
  it("overrides to clean when policy disables fork carry-over", () => {
    const policy: GoalIsolationPolicy = {
      carryOverOnResume: true,
      carryOverOnFork: false,
      maxStalenessMs: 3_600_000,
    };

    const decision = evaluateForkSemantics("copy", "session-1", "session-2", 3, policy);

    expect(decision.mode).toBe("clean");
    expect(decision.forkedGoalState).toBe("no-goal");
    expect(decision.reason).toContain("Policy overrides");
  });

  it("allows copy when policy enables fork carry-over", () => {
    const policy: GoalIsolationPolicy = {
      carryOverOnResume: true,
      carryOverOnFork: true,
      maxStalenessMs: 3_600_000,
    };

    const decision = evaluateForkSemantics("copy", "session-1", "session-2", 3, policy);

    expect(decision.mode).toBe("copy");
    expect(decision.forkedGoalState).toBe("independent-copy");
  });

  it("clean mode is unaffected by policy", () => {
    const policy: GoalIsolationPolicy = {
      carryOverOnResume: true,
      carryOverOnFork: false,
      maxStalenessMs: 3_600_000,
    };

    const decision = evaluateForkSemantics("clean", "session-1", "session-2", 3, policy);

    expect(decision.mode).toBe("clean");
    expect(decision.forkedGoalState).toBe("no-goal");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatForkDecision", () => {
  it("renders copy decision", () => {
    const decision = evaluateForkSemantics("copy", "session-1", "session-2", 3, FORK_ALLOWED_POLICY);
    const output = formatForkDecision(decision);

    expect(output).toContain("COPY");
    expect(output).toContain("📋");
    expect(output).toContain("Source: session-1");
    expect(output).toContain("Forked: session-2");
    expect(output).toContain("independent-copy");
    expect(output).toContain("Goal revision: 3");
  });

  it("renders reference decision", () => {
    const decision = evaluateForkSemantics("reference", "s1", "s2", 2, FORK_ALLOWED_POLICY);
    const output = formatForkDecision(decision);

    expect(output).toContain("REFERENCE");
    expect(output).toContain("🔗");
    expect(output).toContain("shared-reference");
  });

  it("renders clean decision", () => {
    const decision = evaluateForkSemantics("clean", "s1", "s2");
    const output = formatForkDecision(decision);

    expect(output).toContain("CLEAN");
    expect(output).toContain("🧹");
    expect(output).toContain("no-goal");
    expect(output).not.toContain("Goal revision:");
  });

  it("is deterministic", () => {
    const decision = evaluateForkSemantics("copy", "s1", "s2", 3);
    const a = formatForkDecision(decision);
    const b = formatForkDecision(decision);
    expect(a).toBe(b);
  });
});
