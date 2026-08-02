import { describe, it, expect } from "vitest";
import {
  buildWorkSummary,
  formatWorkSummary,
} from "../../src/work-summary.js";
import { generateOutline, updateStepStatus } from "../../src/execution-outline.js";
import { GoalConstraintTracker } from "../../src/goal-constraints.js";

// Pure-function coverage for work summary (Issue #434): summary generation,
// step classification, constraint inclusion, and determinism.

// --- summary generation -----------------------------------------------------

describe("buildWorkSummary", () => {
  it("builds summary from outline with mixed statuses", () => {
    let outline = generateOutline("Build API, write tests, deploy, verify");
    outline = updateStepStatus(outline, 1, "completed", "API built");
    outline = updateStepStatus(outline, 2, "completed", "42 tests pass");
    outline = updateStepStatus(outline, 3, "in-progress");

    const summary = buildWorkSummary(outline, undefined, 5000);

    expect(summary.objective).toBe("Build API, write tests, deploy, verify");
    expect(summary.completedSteps).toHaveLength(2);
    expect(summary.remainingSteps).toHaveLength(2);
    expect(summary.completedSteps[0].description).toBe("Build API");
    expect(summary.completedSteps[0].evidence).toBe("API built");
    expect(summary.remainingSteps[0].status).toBe("in-progress");
    expect(summary.remainingSteps[1].status).toBe("pending");
    expect(summary.progressPct).toBe(50);
    expect(summary.generatedAt).toBe(5000);
  });

  it("handles all-completed outline", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");

    const summary = buildWorkSummary(outline);
    expect(summary.completedSteps).toHaveLength(2);
    expect(summary.remainingSteps).toHaveLength(0);
    expect(summary.progressPct).toBe(100);
  });

  it("handles all-pending outline", () => {
    const outline = generateOutline("Step A, step B, step C");
    const summary = buildWorkSummary(outline);

    expect(summary.completedSteps).toHaveLength(0);
    expect(summary.remainingSteps).toHaveLength(3);
    expect(summary.progressPct).toBe(0);
  });

  it("includes skipped steps as completed", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "skipped");

    const summary = buildWorkSummary(outline);
    expect(summary.completedSteps).toHaveLength(2); // completed + skipped
    expect(summary.remainingSteps).toHaveLength(1);
    expect(summary.progressPct).toBe(67);
  });

  it("includes active constraints", () => {
    const outline = generateOutline("Build API, deploy");
    const constraints = new GoalConstraintTracker();
    constraints.addConstraint("Use OAuth2 flow", "user", 1);
    constraints.addConstraint("Target Node 20+", "user", 1);

    const summary = buildWorkSummary(outline, constraints);
    expect(summary.activeConstraints).toHaveLength(2);
    expect(summary.activeConstraints).toContain("Use OAuth2 flow");
    expect(summary.activeConstraints).toContain("Target Node 20+");
  });

  it("handles no constraints", () => {
    const outline = generateOutline("Build API");
    const summary = buildWorkSummary(outline);
    expect(summary.activeConstraints).toHaveLength(0);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatWorkSummary", () => {
  it("renders summary with completed and remaining steps", () => {
    let outline = generateOutline("Build API, write tests, deploy");
    outline = updateStepStatus(outline, 1, "completed", "API built");
    outline = updateStepStatus(outline, 2, "in-progress");

    const constraints = new GoalConstraintTracker();
    constraints.addConstraint("Use OAuth2 flow", "user", 1);

    const summary = buildWorkSummary(outline, constraints);
    const output = formatWorkSummary(summary);

    expect(output).toContain("Work Summary");
    expect(output).toContain("Build API, write tests, deploy");
    expect(output).toContain("33%");
    expect(output).toContain("✓ Build API — API built");
    expect(output).toContain("▶ write tests [in-progress]");
    expect(output).toContain("○ deploy [pending]");
    expect(output).toContain("Use OAuth2 flow");
  });

  it("renders all-completed summary", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");

    const output = formatWorkSummary(buildWorkSummary(outline));
    expect(output).toContain("100%");
    expect(output).not.toContain("Remaining:");
  });

  it("is deterministic", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "completed");

    const summary = buildWorkSummary(outline, undefined, 5000);
    const a = formatWorkSummary(summary);
    const b = formatWorkSummary(summary);
    expect(a).toBe(b);
  });
});
