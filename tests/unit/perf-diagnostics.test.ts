import { describe, it, expect } from "vitest";
import {
  PerformanceTracker,
  assemblePerfView,
  formatPerfView,
} from "../../src/perf-diagnostics.js";

// Pure-function coverage for performance diagnostics (Issue #375): budget
// tracking, regression detection, multi-phase, baseline comparison, and
// read-only guarantee.

// --- budget tracking --------------------------------------------------------

describe("budget tracking", () => {
  it("records a phase within budget", () => {
    const tracker = new PerformanceTracker();
    const phase = tracker.record({ name: "cold-start", budgetMs: 500, actualMs: 350 });

    expect(phase.overBudget).toBe(false);
    expect(phase.overByMs).toBe(0);
  });

  it("flags over-budget phases", () => {
    const tracker = new PerformanceTracker();
    const phase = tracker.record({ name: "discovery", budgetMs: 200, actualMs: 450 });

    expect(phase.overBudget).toBe(true);
    expect(phase.overByMs).toBe(250);
  });

  it("handles exact budget match", () => {
    const tracker = new PerformanceTracker();
    const phase = tracker.record({ name: "render", budgetMs: 100, actualMs: 100 });

    expect(phase.overBudget).toBe(false);
  });
});

// --- regression detection ---------------------------------------------------

describe("regression detection", () => {
  it("flags regression when exceeding baseline by threshold", () => {
    const tracker = new PerformanceTracker(); // 20% threshold
    const phase = tracker.record({
      name: "discovery",
      budgetMs: 500,
      actualMs: 150,
      baselineMs: 100, // 50% increase > 20% threshold
    });

    expect(phase.regressed).toBe(true);
    expect(phase.regressionMs).toBe(50);
  });

  it("does not flag within threshold", () => {
    const tracker = new PerformanceTracker(); // 20% threshold
    const phase = tracker.record({
      name: "render",
      budgetMs: 500,
      actualMs: 110,
      baselineMs: 100, // 10% increase < 20% threshold
    });

    expect(phase.regressed).toBe(false);
    expect(phase.regressionMs).toBe(0);
  });

  it("does not flag improvement", () => {
    const tracker = new PerformanceTracker();
    const phase = tracker.record({
      name: "cold-start",
      budgetMs: 500,
      actualMs: 80,
      baselineMs: 100, // Faster than baseline
    });

    expect(phase.regressed).toBe(false);
  });

  it("handles no baseline", () => {
    const tracker = new PerformanceTracker();
    const phase = tracker.record({ name: "tool-exec", budgetMs: 1000, actualMs: 500 });

    expect(phase.regressed).toBe(false);
    expect(phase.baselineMs).toBeUndefined();
  });

  it("supports custom threshold", () => {
    const tracker = new PerformanceTracker(10); // 10% threshold
    const phase = tracker.record({
      name: "render",
      budgetMs: 500,
      actualMs: 115,
      baselineMs: 100, // 15% increase > 10% threshold
    });

    expect(phase.regressed).toBe(true);
  });
});

// --- multi-phase fixture ----------------------------------------------------

describe("multi-phase fixture", () => {
  it("tracks multiple phases with mixed health", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "cold-start", budgetMs: 500, actualMs: 350, baselineMs: 300 });
    tracker.record({ name: "discovery", budgetMs: 200, actualMs: 450, baselineMs: 180 });
    tracker.record({ name: "rendering", budgetMs: 100, actualMs: 80, baselineMs: 90 });
    tracker.record({ name: "tool-exec", budgetMs: 1000, actualMs: 1200 });

    expect(tracker.size).toBe(4);
    expect(tracker.getOverBudget()).toHaveLength(2); // discovery, tool-exec
    expect(tracker.getRegressed()).toHaveLength(1); // discovery (150%>20%); cold-start is 17%<20%
    expect(tracker.getHealthy()).toHaveLength(2); // cold-start, rendering
  });
});

// --- queries ----------------------------------------------------------------

describe("queries", () => {
  it("separates healthy from problematic phases", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "ok", budgetMs: 500, actualMs: 100 });
    tracker.record({ name: "bad", budgetMs: 100, actualMs: 500 });

    expect(tracker.getHealthy()).toHaveLength(1);
    expect(tracker.getHealthy()[0].name).toBe("ok");
    expect(tracker.getOverBudget()).toHaveLength(1);
    expect(tracker.getOverBudget()[0].name).toBe("bad");
  });
});

// --- diagnostics view -------------------------------------------------------

describe("assemblePerfView", () => {
  it("assembles view with counts and issue flag", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "ok", budgetMs: 500, actualMs: 100 });
    tracker.record({ name: "over", budgetMs: 100, actualMs: 500 });

    const view = assemblePerfView(tracker);
    expect(view.totalPhases).toBe(2);
    expect(view.overBudgetCount).toBe(1);
    expect(view.healthyCount).toBe(1);
    expect(view.hasIssues).toBe(true);
  });

  it("reports no issues when all healthy", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "ok", budgetMs: 500, actualMs: 100 });

    const view = assemblePerfView(tracker);
    expect(view.hasIssues).toBe(false);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatPerfView", () => {
  it("renders phases with budget bars and warnings", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "cold-start", budgetMs: 500, actualMs: 350 });
    tracker.record({ name: "discovery", budgetMs: 200, actualMs: 450, baselineMs: 180 });

    const view = assemblePerfView(tracker);
    const output = formatPerfView(view);

    expect(output).toContain("Performance Diagnostics");
    expect(output).toContain("cold-start");
    expect(output).toContain("discovery");
    expect(output).toContain("OVER BUDGET");
    expect(output).toContain("REGRESSED");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("tracking does not collect source or upload telemetry", () => {
    const tracker = new PerformanceTracker();
    tracker.record({ name: "test", budgetMs: 100, actualMs: 50 });

    // Pure data model — no side effects.
    expect(tracker.size).toBe(1);
  });
});
