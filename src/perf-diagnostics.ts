// Read-only performance diagnostics: tracks phase timing budgets and
// detects responsiveness regressions.
//
// Phase entries expose name, budget (ms), actual duration (ms),
// over-budget flag, and baseline comparison. Regression detection
// compares actual duration against a versioned baseline. The view is
// read-only and never collects source, uploads telemetry, or modifies
// performance baselines.

export const PERF_DIAGNOSTICS_SCHEMA = "oh-my-cli.perf-diagnostics";
export const PERF_DIAGNOSTICS_VERSION = 1;

// --- phase types ------------------------------------------------------------

export interface PhaseEntry {
  /** Phase name (e.g. "cold-start", "discovery", "rendering"). */
  name: string;
  /** Budget in milliseconds. */
  budgetMs: number;
  /** Actual duration in milliseconds. */
  actualMs: number;
  /** Whether the phase exceeded its budget. */
  overBudget: boolean;
  /** Amount over budget (0 when within). */
  overByMs: number;
  /** Baseline duration from a previous version (when available). */
  baselineMs?: number;
  /** Whether this phase regressed against the baseline. */
  regressed: boolean;
  /** Regression amount in ms (0 when no regression). */
  regressionMs: number;
}

// --- regression threshold ---------------------------------------------------

// A phase is considered regressed if it exceeds the baseline by more than
// this percentage.
const DEFAULT_REGRESSION_THRESHOLD_PCT = 20;

// --- performance tracker ----------------------------------------------------

export class PerformanceTracker {
  private readonly phases: PhaseEntry[] = [];
  private readonly regressionThresholdPct: number;

  constructor(regressionThresholdPct: number = DEFAULT_REGRESSION_THRESHOLD_PCT) {
    this.regressionThresholdPct = regressionThresholdPct;
  }

  /** Record a phase timing. */
  record(opts: {
    name: string;
    budgetMs: number;
    actualMs: number;
    baselineMs?: number;
  }): PhaseEntry {
    const overBudget = opts.actualMs > opts.budgetMs;
    const overByMs = Math.max(0, opts.actualMs - opts.budgetMs);

    let regressed = false;
    let regressionMs = 0;
    if (opts.baselineMs !== undefined && opts.baselineMs > 0) {
      regressionMs = opts.actualMs - opts.baselineMs;
      const pctIncrease = (regressionMs / opts.baselineMs) * 100;
      regressed = pctIncrease > this.regressionThresholdPct;
      if (!regressed) regressionMs = 0;
    }

    const entry: PhaseEntry = {
      name: opts.name,
      budgetMs: opts.budgetMs,
      actualMs: opts.actualMs,
      overBudget,
      overByMs,
      baselineMs: opts.baselineMs,
      regressed,
      regressionMs,
    };

    this.phases.push(entry);
    return entry;
  }

  list(): PhaseEntry[] {
    return [...this.phases];
  }

  /** Get phases that exceeded their budget. */
  getOverBudget(): PhaseEntry[] {
    return this.phases.filter((p) => p.overBudget);
  }

  /** Get phases that regressed against baseline. */
  getRegressed(): PhaseEntry[] {
    return this.phases.filter((p) => p.regressed);
  }

  /** Get phases that are healthy (within budget, no regression). */
  getHealthy(): PhaseEntry[] {
    return this.phases.filter((p) => !p.overBudget && !p.regressed);
  }

  get size(): number {
    return this.phases.length;
  }
}

// --- diagnostics view -------------------------------------------------------

export interface PerfDiagnosticsView {
  schema: typeof PERF_DIAGNOSTICS_SCHEMA;
  v: typeof PERF_DIAGNOSTICS_VERSION;
  phases: PhaseEntry[];
  totalPhases: number;
  overBudgetCount: number;
  regressedCount: number;
  healthyCount: number;
  hasIssues: boolean;
  snapshotAt: number;
}

export function assemblePerfView(tracker: PerformanceTracker): PerfDiagnosticsView {
  const phases = tracker.list();
  return {
    schema: PERF_DIAGNOSTICS_SCHEMA,
    v: PERF_DIAGNOSTICS_VERSION,
    phases,
    totalPhases: phases.length,
    overBudgetCount: tracker.getOverBudget().length,
    regressedCount: tracker.getRegressed().length,
    healthyCount: tracker.getHealthy().length,
    hasIssues: tracker.getOverBudget().length > 0 || tracker.getRegressed().length > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

export function formatPerfView(view: PerfDiagnosticsView): string {
  const lines: string[] = [];
  lines.push("Performance Diagnostics");
  lines.push("═".repeat(50));
  lines.push(`Phases: ${view.totalPhases}  Over budget: ${view.overBudgetCount}  Regressed: ${view.regressedCount}  Healthy: ${view.healthyCount}`);

  if (view.hasIssues) {
    lines.push("⚠ Performance issues detected");
  }

  for (const phase of view.phases) {
    const icon = phase.overBudget ? "✗" : phase.regressed ? "⚠" : "✓";
    const bar = budgetBar(phase.actualMs, phase.budgetMs);
    lines.push(`${icon} ${phase.name} ${bar} ${phase.actualMs}ms / ${phase.budgetMs}ms`);

    if (phase.overBudget) {
      lines.push(`  ✗ OVER BUDGET by ${phase.overByMs}ms`);
    }
    if (phase.regressed) {
      lines.push(`  ⚠ REGRESSED +${phase.regressionMs}ms vs baseline ${phase.baselineMs}ms`);
    }
  }

  lines.push("");
  lines.push("Read-only: no source collected, no telemetry uploaded.");

  return lines.join("\n");
}

function budgetBar(actual: number, budget: number): string {
  const width = 20;
  const ratio = budget > 0 ? actual / budget : 1;
  // Issue #846: clamp the fill into [0, width] so a negative actual (e.g. a
  // clock-skewed elapsed duration) renders an empty bar instead of throwing a
  // RangeError from a negative repeat count, matching #808's convention.
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
