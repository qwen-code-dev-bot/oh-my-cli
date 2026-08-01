// Read-only budget tracking: attributes token usage and estimated cost to
// individual agents and sessions from real lifecycle events.
//
// Budget entries expose agent id, session id, token limit, consumed tokens,
// estimated cost, and utilization percentage. Over-budget agents are flagged
// with visible warnings. Cost attribution derives from real token counts and
// configurable per-model rates. The view is read-only and never modifies
// budgets, cancels agents, or adjusts limits.

export const BUDGET_TRACKING_SCHEMA = "oh-my-cli.budget-tracking";
export const BUDGET_TRACKING_VERSION = 1;

// --- budget entries ---------------------------------------------------------

export interface BudgetEntry {
  /** Agent identifier. */
  agentId: string;
  /** Session identifier. */
  sessionId: string;
  /** Token budget limit. */
  tokenLimit: number;
  /** Tokens consumed so far. */
  tokensConsumed: number;
  /** Utilization percentage (0-100+). */
  utilizationPct: number;
  /** Whether the agent is over budget. */
  overBudget: boolean;
  /** Amount over budget (0 when within budget). */
  overBy: number;
  /** Estimated cost in USD. */
  estimatedCostUsd: number;
  /** Model identifier used for cost calculation. */
  model: string;
}

// --- cost rates -------------------------------------------------------------

export interface ModelRate {
  /** Cost per 1M input tokens (USD). */
  inputPerMillion: number;
  /** Cost per 1M output tokens (USD). */
  outputPerMillion: number;
}

// Default rates for common models (USD per 1M tokens).
const DEFAULT_RATES: Record<string, ModelRate> = {
  "qwen3-max": { inputPerMillion: 2.0, outputPerMillion: 8.0 },
  "qwen3-coder": { inputPerMillion: 1.0, outputPerMillion: 4.0 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "claude-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
};

// Estimate cost from token counts and model rate.
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  rates: Record<string, ModelRate> = DEFAULT_RATES,
): number {
  const rate = rates[model] ?? { inputPerMillion: 1.0, outputPerMillion: 1.0 };
  return (inputTokens / 1_000_000) * rate.inputPerMillion +
         (outputTokens / 1_000_000) * rate.outputPerMillion;
}

// --- budget tracker ---------------------------------------------------------

export class BudgetTracker {
  private readonly entries = new Map<string, BudgetEntry>();
  private readonly rates: Record<string, ModelRate>;

  constructor(rates: Record<string, ModelRate> = DEFAULT_RATES) {
    this.rates = rates;
  }

  /** Register an agent with a token budget. */
  register(opts: {
    agentId: string;
    sessionId: string;
    tokenLimit: number;
    model: string;
  }): BudgetEntry {
    const entry: BudgetEntry = {
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      tokenLimit: opts.tokenLimit,
      tokensConsumed: 0,
      utilizationPct: 0,
      overBudget: false,
      overBy: 0,
      estimatedCostUsd: 0,
      model: opts.model,
    };
    this.entries.set(opts.agentId, entry);
    return entry;
  }

  /** Record token consumption for an agent. */
  recordUsage(agentId: string, inputTokens: number, outputTokens: number): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;

    const totalTokens = inputTokens + outputTokens;
    entry.tokensConsumed += totalTokens;
    entry.utilizationPct = entry.tokenLimit > 0
      ? Math.round((entry.tokensConsumed / entry.tokenLimit) * 100)
      : 0;
    entry.overBudget = entry.tokensConsumed > entry.tokenLimit;
    entry.overBy = Math.max(0, entry.tokensConsumed - entry.tokenLimit);
    entry.estimatedCostUsd += estimateCost(inputTokens, outputTokens, entry.model, this.rates);
  }

  get(agentId: string): BudgetEntry | undefined {
    return this.entries.get(agentId);
  }

  /** Get all entries. */
  list(): BudgetEntry[] {
    return [...this.entries.values()];
  }

  /** Get over-budget agents. */
  getOverBudget(): BudgetEntry[] {
    return this.list().filter((e) => e.overBudget);
  }

  /** Get total estimated cost across all agents. */
  getTotalCost(): number {
    return this.list().reduce((sum, e) => sum + e.estimatedCostUsd, 0);
  }

  get size(): number {
    return this.entries.size;
  }
}

// --- budget view ------------------------------------------------------------

export interface BudgetView {
  schema: typeof BUDGET_TRACKING_SCHEMA;
  v: typeof BUDGET_TRACKING_VERSION;
  entries: BudgetEntry[];
  totalAgents: number;
  overBudgetCount: number;
  totalCostUsd: number;
  hasOverBudget: boolean;
  snapshotAt: number;
}

// Assemble a read-only budget view.
export function assembleBudgetView(tracker: BudgetTracker): BudgetView {
  const entries = tracker.list();
  const overBudget = tracker.getOverBudget();

  return {
    schema: BUDGET_TRACKING_SCHEMA,
    v: BUDGET_TRACKING_VERSION,
    entries,
    totalAgents: entries.length,
    overBudgetCount: overBudget.length,
    totalCostUsd: tracker.getTotalCost(),
    hasOverBudget: overBudget.length > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format a budget view as a compact TUI view.
export function formatBudgetView(view: BudgetView): string {
  const lines: string[] = [];
  lines.push("Budget Tracking");
  lines.push("═".repeat(50));
  lines.push(`Agents: ${view.totalAgents}  Over budget: ${view.overBudgetCount}  Total cost: $${view.totalCostUsd.toFixed(4)}`);

  if (view.hasOverBudget) {
    lines.push("⚠ Over-budget agents detected");
  }

  for (const entry of view.entries) {
    const icon = entry.overBudget ? "⚠" : "●";
    const bar = utilizationBar(entry.utilizationPct);
    lines.push(`${icon} ${entry.agentId} [${entry.model}] ${bar} ${entry.utilizationPct}%`);
    lines.push(`  tokens: ${entry.tokensConsumed} / ${entry.tokenLimit}  cost: $${entry.estimatedCostUsd.toFixed(4)}`);
    if (entry.overBudget) {
      lines.push(`  ⚠ OVER BUDGET by ${entry.overBy} tokens`);
    }
  }

  lines.push("");
  lines.push("Read-only: no budgets modified, no agents cancelled.");

  return lines.join("\n");
}

// Render a simple text progress bar.
function utilizationBar(pct: number): string {
  const width = 20;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
