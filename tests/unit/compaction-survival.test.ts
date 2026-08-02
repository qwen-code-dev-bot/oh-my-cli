import { describe, it, expect } from "vitest";
import {
  buildSurvivalBlock,
  formatSurvivalBlock,
} from "../../src/compaction-survival.js";
import { generateOutline, updateStepStatus } from "../../src/execution-outline.js";
import { buildWorkSummary } from "../../src/work-summary.js";
import { GoalConstraintTracker } from "../../src/goal-constraints.js";

// Pure-function coverage for compaction survival (Issue #436): block
// generation, bounding, and determinism.

function makeSummary() {
  let outline = generateOutline("Build API, write tests, deploy");
  outline = updateStepStatus(outline, 1, "completed", "API built");
  outline = updateStepStatus(outline, 2, "in-progress");
  return buildWorkSummary(outline, undefined, 5000);
}

// --- block generation -------------------------------------------------------

describe("buildSurvivalBlock", () => {
  it("builds block from work summary", () => {
    const summary = makeSummary();
    const block = buildSurvivalBlock(summary, ["Use OAuth2 flow"], 5000);

    expect(block.objective).toBe("Build API, write tests, deploy");
    expect(block.progressPct).toBe(33);
    expect(block.completedSteps).toEqual(["Build API"]);
    expect(block.remainingSteps).toEqual(["write tests", "deploy"]);
    expect(block.pinnedConstraints).toEqual(["Use OAuth2 flow"]);
    expect(block.generatedAt).toBe(5000);
    expect(block.charCount).toBeGreaterThan(0);
  });

  it("handles empty summary", () => {
    const outline = generateOutline("Fix bug");
    const summary = buildWorkSummary(outline);
    const block = buildSurvivalBlock(summary);

    expect(block.objective).toBe("Fix bug");
    expect(block.progressPct).toBe(0);
    expect(block.completedSteps).toHaveLength(0);
    expect(block.remainingSteps).toHaveLength(1);
    expect(block.pinnedConstraints).toHaveLength(0);
  });

  it("truncates long step descriptions", () => {
    let outline = generateOutline("x".repeat(200) + ", step B");
    outline = updateStepStatus(outline, 1, "completed");
    const summary = buildWorkSummary(outline);
    const block = buildSurvivalBlock(summary);

    expect(block.completedSteps[0].length).toBeLessThanOrEqual(80);
  });

  it("truncates long constraints", () => {
    const summary = makeSummary();
    const block = buildSurvivalBlock(summary, ["x".repeat(200)]);

    expect(block.pinnedConstraints[0].length).toBeLessThanOrEqual(100);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatSurvivalBlock", () => {
  it("renders compact block with goal context markers", () => {
    const summary = makeSummary();
    const block = buildSurvivalBlock(summary, ["Use OAuth2 flow"], 5000);
    const output = formatSurvivalBlock(block);

    expect(output).toContain("[GOAL CONTEXT]");
    expect(output).toContain("[/GOAL CONTEXT]");
    expect(output).toContain("Objective: Build API, write tests, deploy");
    expect(output).toContain("Progress: 33%");
    expect(output).toContain("Done: Build API");
    expect(output).toContain("Todo: write tests; deploy");
    expect(output).toContain("Constraints: Use OAuth2 flow");
  });

  it("bounds output at 2000 chars", () => {
    let outline = generateOutline(
      Array.from({ length: 20 }, (_, i) => `Step ${i} with a very long description that goes on and on`).join(", "),
    );
    for (let i = 1; i <= 20; i++) {
      outline = updateStepStatus(outline, i, "completed", "Done");
    }
    const summary = buildWorkSummary(outline);
    const constraints = Array.from({ length: 10 }, (_, i) => `Constraint ${i} with a long description`);
    const block = buildSurvivalBlock(summary, constraints);
    const output = formatSurvivalBlock(block);

    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toContain("[/GOAL CONTEXT]");
  });

  it("is deterministic", () => {
    const summary = makeSummary();
    const block = buildSurvivalBlock(summary, ["Test"], 5000);
    const a = formatSurvivalBlock(block);
    const b = formatSurvivalBlock(block);
    expect(a).toBe(b);
  });
});
