import { describe, it, expect } from "vitest";
import {
  evaluateBudget,
  formatBudgetStatus,
  DEFAULT_GOAL_BUDGET,
  type GoalBudget,
  type BudgetUsage,
} from "../../src/goal-budgets.js";

// Pure-function coverage for Goal budgets (Issue #446): budget evaluation,
// default/override handling, exhaustion detection, and determinism.

// --- budget evaluation ------------------------------------------------------

describe("evaluateBudget", () => {
  it("evaluates budget with partial usage", () => {
    const usage: BudgetUsage = { tokensUsed: 50_000, timeMs: 1_800_000, costUsd: 2.5, toolCalls: 250 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);

    expect(evaluation.exhausted).toBe(false);
    expect(evaluation.exhaustedDimensions).toHaveLength(0);
    expect(evaluation.remaining.tokens).toBe(50_000);
    expect(evaluation.remaining.timeMs).toBe(1_800_000);
    expect(evaluation.remaining.costUsd).toBe(2.5);
    expect(evaluation.remaining.toolCalls).toBe(250);
    expect(evaluation.usagePct.tokens).toBe(50);
    expect(evaluation.usagePct.time).toBe(50);
    expect(evaluation.usagePct.cost).toBe(50);
    expect(evaluation.usagePct.toolCalls).toBe(50);
  });

  it("detects token exhaustion", () => {
    const usage: BudgetUsage = { tokensUsed: 100_000, timeMs: 0, costUsd: 0, toolCalls: 0 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);

    expect(evaluation.exhausted).toBe(true);
    expect(evaluation.exhaustedDimensions).toContain("tokens");
    expect(evaluation.remaining.tokens).toBe(0);
    expect(evaluation.usagePct.tokens).toBe(100);
  });

  it("detects multiple exhausted dimensions", () => {
    const usage: BudgetUsage = { tokensUsed: 100_000, timeMs: 3_600_000, costUsd: 5.0, toolCalls: 500 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);

    expect(evaluation.exhausted).toBe(true);
    expect(evaluation.exhaustedDimensions).toHaveLength(4);
  });

  it("handles zero usage", () => {
    const usage: BudgetUsage = { tokensUsed: 0, timeMs: 0, costUsd: 0, toolCalls: 0 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);

    expect(evaluation.exhausted).toBe(false);
    expect(evaluation.usagePct.tokens).toBe(0);
  });
});

// --- default/override handling ----------------------------------------------

describe("budget overrides", () => {
  it("supports custom budgets", () => {
    const customBudget: GoalBudget = {
      maxTokens: 50_000,
      maxTimeMs: 1_800_000,
      maxCostUsd: 2.0,
      maxToolCalls: 200,
    };
    const usage: BudgetUsage = { tokensUsed: 40_000, timeMs: 900_000, costUsd: 1.5, toolCalls: 150 };
    const evaluation = evaluateBudget(customBudget, usage);

    expect(evaluation.budget.maxTokens).toBe(50_000);
    expect(evaluation.usagePct.tokens).toBe(80);
    expect(evaluation.remaining.tokens).toBe(10_000);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatBudgetStatus", () => {
  it("renders budget status with bars", () => {
    const usage: BudgetUsage = { tokensUsed: 50_000, timeMs: 1_800_000, costUsd: 2.5, toolCalls: 250 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);
    const output = formatBudgetStatus(evaluation);

    expect(output).toContain("Goal Budget");
    expect(output).toContain("Tokens:");
    expect(output).toContain("50000/100000 (50%)");
    expect(output).toContain("Time:");
    expect(output).toContain("Cost:");
    expect(output).toContain("Tool calls:");
  });

  it("shows exhaustion warning", () => {
    const usage: BudgetUsage = { tokensUsed: 100_000, timeMs: 0, costUsd: 0, toolCalls: 0 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);
    const output = formatBudgetStatus(evaluation);

    expect(output).toContain("⚠EXHAUSTED");
    expect(output).toContain("Budget exhausted: tokens");
  });

  it("is deterministic", () => {
    const usage: BudgetUsage = { tokensUsed: 50_000, timeMs: 1_800_000, costUsd: 2.5, toolCalls: 250 };
    const evaluation = evaluateBudget(DEFAULT_GOAL_BUDGET, usage);
    const a = formatBudgetStatus(evaluation);
    const b = formatBudgetStatus(evaluation);
    expect(a).toBe(b);
  });
});
