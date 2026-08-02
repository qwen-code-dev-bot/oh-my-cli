import { describe, it, expect } from "vitest";
import {
  evaluateAutoAchieve,
  formatAchieveGuardStatus,
  type ExecutionOutcome,
} from "../../src/auto-achieve-guard.js";

// Pure-function coverage for auto-achieve guard (Issue #448): guard
// evaluation, blocker detection, and determinism.

// --- safe evaluation --------------------------------------------------------

describe("safe evaluation", () => {
  it("allows auto-achieve on success", () => {
    const evaluation = evaluateAutoAchieve("success");

    expect(evaluation.safe).toBe(true);
    expect(evaluation.outcome).toBe("success");
    expect(evaluation.blocker).toBeUndefined();
    expect(evaluation.reason).toContain("successfully");
  });
});

// --- blocked evaluation -----------------------------------------------------

describe("blocked evaluation", () => {
  it("blocks auto-achieve on provider failure", () => {
    const evaluation = evaluateAutoAchieve("provider-failure");

    expect(evaluation.safe).toBe(false);
    expect(evaluation.blocker).toBe("provider-failure");
    expect(evaluation.reason).toContain("Provider failed");
  });

  it("blocks auto-achieve on interruption", () => {
    const evaluation = evaluateAutoAchieve("interrupted");

    expect(evaluation.safe).toBe(false);
    expect(evaluation.blocker).toBe("interruption");
    expect(evaluation.reason).toContain("interrupted");
  });

  it("blocks auto-achieve on cancellation", () => {
    const evaluation = evaluateAutoAchieve("cancelled");

    expect(evaluation.safe).toBe(false);
    expect(evaluation.blocker).toBe("cancellation");
    expect(evaluation.reason).toContain("cancelled");
  });

  it("blocks auto-achieve on budget exhaustion", () => {
    const evaluation = evaluateAutoAchieve("budget-exhausted");

    expect(evaluation.safe).toBe(false);
    expect(evaluation.blocker).toBe("budget-exhausted");
    expect(evaluation.reason).toContain("Budget exhausted");
  });

  it("blocks auto-achieve on stale revision", () => {
    const evaluation = evaluateAutoAchieve("stale-revision");

    expect(evaluation.safe).toBe(false);
    expect(evaluation.blocker).toBe("stale-revision");
    expect(evaluation.reason).toContain("Stale revision");
  });
});

// --- all outcomes covered ---------------------------------------------------

describe("all outcomes", () => {
  it("covers all defined outcomes", () => {
    const outcomes: ExecutionOutcome[] = [
      "success", "provider-failure", "interrupted", "cancelled",
      "budget-exhausted", "stale-revision",
    ];

    for (const outcome of outcomes) {
      const evaluation = evaluateAutoAchieve(outcome);
      expect(evaluation.outcome).toBe(outcome);
      expect(evaluation.reason.length).toBeGreaterThan(0);
    }
  });

  it("only success is safe", () => {
    const outcomes: ExecutionOutcome[] = [
      "success", "provider-failure", "interrupted", "cancelled",
      "budget-exhausted", "stale-revision",
    ];

    const safeOutcomes = outcomes.filter((o) => evaluateAutoAchieve(o).safe);
    expect(safeOutcomes).toEqual(["success"]);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAchieveGuardStatus", () => {
  it("renders safe status", () => {
    const evaluation = evaluateAutoAchieve("success");
    const output = formatAchieveGuardStatus(evaluation);

    expect(output).toContain("SAFE");
    expect(output).toContain("✓");
    expect(output).toContain("Outcome: success");
  });

  it("renders blocked status with blocker", () => {
    const evaluation = evaluateAutoAchieve("provider-failure");
    const output = formatAchieveGuardStatus(evaluation);

    expect(output).toContain("BLOCKED");
    expect(output).toContain("⊘");
    expect(output).toContain("Blocker: provider-failure");
    expect(output).toContain("Provider failed");
  });

  it("is deterministic", () => {
    const evaluation = evaluateAutoAchieve("success");
    const a = formatAchieveGuardStatus(evaluation);
    const b = formatAchieveGuardStatus(evaluation);
    expect(a).toBe(b);
  });
});
