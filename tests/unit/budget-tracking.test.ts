import { describe, it, expect } from "vitest";
import {
  BudgetTracker,
  estimateCost,
  assembleBudgetView,
  formatBudgetView,
} from "../../src/budget-tracking.js";

// Pure-function coverage for budget tracking (Issue #362): budget entries,
// over-budget detection, cost attribution, multi-agent fixtures, and
// read-only guarantee.

// --- cost estimation --------------------------------------------------------

describe("estimateCost", () => {
  it("calculates cost from token counts and model rate", () => {
    // qwen3-max: $2/M input, $8/M output
    const cost = estimateCost(1_000_000, 500_000, "qwen3-max");
    expect(cost).toBeCloseTo(2.0 + 4.0, 4); // $2 input + $4 output
  });

  it("uses fallback rate for unknown models", () => {
    const cost = estimateCost(1_000_000, 1_000_000, "unknown-model");
    expect(cost).toBeCloseTo(2.0, 4); // $1/M each
  });

  it("handles zero tokens", () => {
    expect(estimateCost(0, 0, "qwen3-max")).toBe(0);
  });
});

// --- budget tracking --------------------------------------------------------

describe("budget tracking", () => {
  it("registers an agent with zero consumption", () => {
    const tracker = new BudgetTracker();
    const entry = tracker.register({
      agentId: "a1",
      sessionId: "s1",
      tokenLimit: 100_000,
      model: "qwen3-max",
    });

    expect(entry.tokensConsumed).toBe(0);
    expect(entry.utilizationPct).toBe(0);
    expect(entry.overBudget).toBe(false);
    expect(entry.estimatedCostUsd).toBe(0);
  });

  it("tracks token consumption and utilization", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.recordUsage("a1", 30_000, 20_000);

    const entry = tracker.get("a1")!;
    expect(entry.tokensConsumed).toBe(50_000);
    expect(entry.utilizationPct).toBe(50);
    expect(entry.overBudget).toBe(false);
    expect(entry.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("detects over-budget agents", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 10_000, model: "qwen3-max" });
    tracker.recordUsage("a1", 8_000, 5_000);

    const entry = tracker.get("a1")!;
    expect(entry.overBudget).toBe(true);
    expect(entry.overBy).toBe(3_000);
    expect(entry.utilizationPct).toBe(130);
  });

  it("accumulates usage across multiple records", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.recordUsage("a1", 10_000, 5_000);
    tracker.recordUsage("a1", 20_000, 10_000);

    expect(tracker.get("a1")!.tokensConsumed).toBe(45_000);
  });
});

// --- multi-agent fixture ----------------------------------------------------

describe("multi-agent fixture", () => {
  it("tracks multiple agents with different budgets", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.register({ agentId: "a2", sessionId: "s1", tokenLimit: 50_000, model: "qwen3-coder" });

    tracker.recordUsage("a1", 30_000, 10_000);
    tracker.recordUsage("a2", 40_000, 20_000); // Over 50k limit.

    expect(tracker.size).toBe(2);
    expect(tracker.getOverBudget()).toHaveLength(1);
    expect(tracker.getOverBudget()[0].agentId).toBe("a2");
    expect(tracker.getTotalCost()).toBeGreaterThan(0);
  });
});

// --- cost attribution -------------------------------------------------------

describe("cost attribution", () => {
  it("attributes cost based on model rate", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 1_000_000, model: "qwen3-max" });
    tracker.recordUsage("a1", 1_000_000, 0);

    // qwen3-max: $2/M input
    expect(tracker.get("a1")!.estimatedCostUsd).toBeCloseTo(2.0, 4);
  });

  it("uses custom rates", () => {
    const customRates = { "custom-model": { inputPerMillion: 5.0, outputPerMillion: 10.0 } };
    const tracker = new BudgetTracker(customRates);
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 1_000_000, model: "custom-model" });
    tracker.recordUsage("a1", 1_000_000, 500_000);

    expect(tracker.get("a1")!.estimatedCostUsd).toBeCloseTo(5.0 + 5.0, 4);
  });
});

// --- budget view ------------------------------------------------------------

describe("assembleBudgetView", () => {
  it("assembles view with counts and over-budget flag", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.register({ agentId: "a2", sessionId: "s1", tokenLimit: 10_000, model: "qwen3-max" });
    tracker.recordUsage("a2", 15_000, 0);

    const view = assembleBudgetView(tracker);
    expect(view.totalAgents).toBe(2);
    expect(view.overBudgetCount).toBe(1);
    expect(view.hasOverBudget).toBe(true);
    expect(view.totalCostUsd).toBeGreaterThan(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatBudgetView", () => {
  it("renders agents with utilization and over-budget warnings", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "agent-1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.register({ agentId: "agent-2", sessionId: "s1", tokenLimit: 10_000, model: "qwen3-coder" });
    tracker.recordUsage("agent-1", 50_000, 0);
    tracker.recordUsage("agent-2", 15_000, 0);

    const view = assembleBudgetView(tracker);
    const output = formatBudgetView(view);

    expect(output).toContain("Budget Tracking");
    expect(output).toContain("agent-1");
    expect(output).toContain("50%");
    expect(output).toContain("agent-2");
    expect(output).toContain("OVER BUDGET");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("view assembly does not mutate tracker", () => {
    const tracker = new BudgetTracker();
    tracker.register({ agentId: "a1", sessionId: "s1", tokenLimit: 100_000, model: "qwen3-max" });
    tracker.recordUsage("a1", 10_000, 5_000);

    const before = tracker.get("a1")!.tokensConsumed;
    assembleBudgetView(tracker);
    expect(tracker.get("a1")!.tokensConsumed).toBe(before);
  });
});
