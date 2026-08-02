// Goal budgets: per-Goal budgets with clear defaults and remaining-budget
// display.
//
// Defines token, time, cost, and tool-call limits with defaults and
// per-Goal overrides. Evaluates remaining budget and exhaustion status.
// Read-only evaluation, deterministic.

export const GOAL_BUDGETS_SCHEMA = "oh-my-cli.goal-budgets";
export const GOAL_BUDGETS_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface GoalBudget {
  /** Maximum tokens allowed. */
  maxTokens: number;
  /** Maximum time in milliseconds. */
  maxTimeMs: number;
  /** Maximum cost in USD. */
  maxCostUsd: number;
  /** Maximum tool calls allowed. */
  maxToolCalls: number;
}

export interface BudgetUsage {
  /** Tokens consumed so far. */
  tokensUsed: number;
  /** Time elapsed in milliseconds. */
  timeMs: number;
  /** Cost incurred in USD. */
  costUsd: number;
  /** Tool calls made. */
  toolCalls: number;
}

export type BudgetDimension = "tokens" | "time" | "cost" | "tool-calls";

export interface BudgetEvaluation {
  schema: typeof GOAL_BUDGETS_SCHEMA;
  v: typeof GOAL_BUDGETS_VERSION;
  /** The budget being evaluated. */
  budget: GoalBudget;
  /** Current usage. */
  usage: BudgetUsage;
  /** Remaining budget per dimension. */
  remaining: {
    tokens: number;
    timeMs: number;
    costUsd: number;
    toolCalls: number;
  };
  /** Whether any budget dimension is exhausted. */
  exhausted: boolean;
  /** Which dimensions are exhausted. */
  exhaustedDimensions: BudgetDimension[];
  /** Usage percentages per dimension. */
  usagePct: {
    tokens: number;
    time: number;
    cost: number;
    toolCalls: number;
  };
}

// --- defaults ---------------------------------------------------------------

export const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxTokens: 100_000,
  maxTimeMs: 3_600_000, // 1 hour
  maxCostUsd: 5.0,
  maxToolCalls: 500,
};

// --- budget evaluation ------------------------------------------------------

function pct(used: number, max: number): number {
  return max > 0 ? Math.round((used / max) * 100) : 0;
}

// Evaluate budget usage against limits.
export function evaluateBudget(
  budget: GoalBudget,
  usage: BudgetUsage,
): BudgetEvaluation {
  const remaining = {
    tokens: Math.max(0, budget.maxTokens - usage.tokensUsed),
    timeMs: Math.max(0, budget.maxTimeMs - usage.timeMs),
    costUsd: Math.max(0, budget.maxCostUsd - usage.costUsd),
    toolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
  };

  const exhaustedDimensions: BudgetDimension[] = [];
  if (usage.tokensUsed >= budget.maxTokens) exhaustedDimensions.push("tokens");
  if (usage.timeMs >= budget.maxTimeMs) exhaustedDimensions.push("time");
  if (usage.costUsd >= budget.maxCostUsd) exhaustedDimensions.push("cost");
  if (usage.toolCalls >= budget.maxToolCalls) exhaustedDimensions.push("tool-calls");

  return {
    schema: GOAL_BUDGETS_SCHEMA,
    v: GOAL_BUDGETS_VERSION,
    budget,
    usage,
    remaining,
    exhausted: exhaustedDimensions.length > 0,
    exhaustedDimensions,
    usagePct: {
      tokens: pct(usage.tokensUsed, budget.maxTokens),
      time: pct(usage.timeMs, budget.maxTimeMs),
      cost: pct(usage.costUsd, budget.maxCostUsd),
      toolCalls: pct(usage.toolCalls, budget.maxToolCalls),
    },
  };
}

// --- formatting -------------------------------------------------------------

export function formatBudgetStatus(evaluation: BudgetEvaluation): string {
  const lines: string[] = [];

  lines.push("Goal Budget");
  lines.push("═".repeat(50));

  const dims: Array<{ label: string; used: string; max: string; pct: number; exhausted: boolean }> = [
    { label: "Tokens", used: `${evaluation.usage.tokensUsed}`, max: `${evaluation.budget.maxTokens}`, pct: evaluation.usagePct.tokens, exhausted: evaluation.exhaustedDimensions.includes("tokens") },
    { label: "Time", used: formatTime(evaluation.usage.timeMs), max: formatTime(evaluation.budget.maxTimeMs), pct: evaluation.usagePct.time, exhausted: evaluation.exhaustedDimensions.includes("time") },
    { label: "Cost", used: `$${evaluation.usage.costUsd.toFixed(2)}`, max: `$${evaluation.budget.maxCostUsd.toFixed(2)}`, pct: evaluation.usagePct.cost, exhausted: evaluation.exhaustedDimensions.includes("cost") },
    { label: "Tool calls", used: `${evaluation.usage.toolCalls}`, max: `${evaluation.budget.maxToolCalls}`, pct: evaluation.usagePct.toolCalls, exhausted: evaluation.exhaustedDimensions.includes("tool-calls") },
  ];

  for (const dim of dims) {
    const bar = budgetBar(dim.pct);
    const warn = dim.exhausted ? " ⚠EXHAUSTED" : "";
    lines.push(`  ${dim.label}: ${bar} ${dim.used}/${dim.max} (${dim.pct}%)${warn}`);
  }

  if (evaluation.exhausted) {
    lines.push("");
    lines.push(`⚠ Budget exhausted: ${evaluation.exhaustedDimensions.join(", ")}`);
  }

  return lines.join("\n");
}

function budgetBar(pct: number): string {
  const width = 15;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function formatTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h${remainMinutes}m`;
}
