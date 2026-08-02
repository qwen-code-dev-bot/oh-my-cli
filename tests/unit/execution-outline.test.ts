import { describe, it, expect } from "vitest";
import {
  generateOutline,
  isPlanningRequired,
  safeStepDescription,
  updateStepStatus,
  formatOutline,
} from "../../src/execution-outline.js";

// Pure-function coverage for execution outline (Issue #405): outline
// generation, step tracking, planning bypass, bounding, redaction,
// and determinism.

// --- planning heuristic -----------------------------------------------------

describe("isPlanningRequired", () => {
  it("requires planning for multi-step objectives with commas", () => {
    expect(isPlanningRequired("Refactor auth, add tests, update docs")).toBe(true);
  });

  it("requires planning for objectives with 'and'", () => {
    expect(isPlanningRequired("Build the API and write integration tests")).toBe(true);
  });

  it("requires planning for objectives with 'then'", () => {
    expect(isPlanningRequired("Deploy to staging then verify health checks")).toBe(true);
  });

  it("requires planning for long objectives", () => {
    expect(isPlanningRequired("x".repeat(150))).toBe(true);
  });

  it("bypasses planning for simple objectives", () => {
    expect(isPlanningRequired("Fix the login bug")).toBe(false);
    expect(isPlanningRequired("Add dark mode")).toBe(false);
  });
});

// --- outline generation -----------------------------------------------------

describe("generateOutline", () => {
  it("generates steps from comma-separated objective", () => {
    const outline = generateOutline("Refactor auth, add tests, update docs");
    expect(outline.totalSteps).toBe(3);
    expect(outline.steps[0].description).toBe("Refactor auth");
    expect(outline.steps[1].description).toBe("add tests");
    expect(outline.steps[2].description).toBe("update docs");
    expect(outline.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("generates steps from 'and'/'then' separated objective", () => {
    const outline = generateOutline("Build the API and write tests then deploy");
    expect(outline.totalSteps).toBe(3);
  });

  it("generates single step for simple objective", () => {
    const outline = generateOutline("Fix the login bug");
    expect(outline.totalSteps).toBe(1);
    expect(outline.steps[0].description).toBe("Fix the login bug");
    expect(outline.truncated).toBe(false);
  });

  it("bounds steps at 10", () => {
    const manySteps = Array.from({ length: 15 }, (_, i) => `step ${i + 1}`).join(", ");
    const outline = generateOutline(manySteps);
    expect(outline.totalSteps).toBe(10);
    expect(outline.truncated).toBe(true);
  });

  it("is deterministic", () => {
    const a = generateOutline("Build API, write tests, deploy");
    const b = generateOutline("Build API, write tests, deploy");
    expect(a.steps.map((s) => s.description)).toEqual(b.steps.map((s) => s.description));
  });
});

// --- step description safety ------------------------------------------------

describe("safeStepDescription", () => {
  it("bounds at 200 chars", () => {
    const long = "x".repeat(500);
    expect(safeStepDescription(long).length).toBeLessThanOrEqual(200);
  });

  it("redacts secrets", () => {
    const safe = safeStepDescription("Deploy with --token=supersecretvalue123");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("supersecretvalue123");
  });

  it("strips control characters", () => {
    const safe = safeStepDescription("hello\u0000world");
    expect(safe).not.toContain("\u0000");
  });
});

// --- step tracking ----------------------------------------------------------

describe("updateStepStatus", () => {
  it("updates step status", () => {
    const outline = generateOutline("Build API, write tests");
    const updated = updateStepStatus(outline, 1, "in-progress");
    expect(updated.steps[0].status).toBe("in-progress");
    expect(updated.steps[1].status).toBe("pending");
  });

  it("records evidence on completion", () => {
    const outline = generateOutline("Build API, write tests");
    const updated = updateStepStatus(outline, 1, "completed", "All 42 tests pass");
    expect(updated.steps[0].status).toBe("completed");
    expect(updated.steps[0].evidence).toBe("All 42 tests pass");
    expect(updated.completedSteps).toBe(1);
  });

  it("tracks completed step count", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");
    expect(outline.completedSteps).toBe(2);
  });

  it("supports failed and skipped statuses", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "failed", "CI error");
    outline = updateStepStatus(outline, 2, "skipped");
    expect(outline.steps[0].status).toBe("failed");
    expect(outline.steps[1].status).toBe("skipped");
  });

  it("does not mutate the original outline", () => {
    const outline = generateOutline("Build API, write tests");
    const updated = updateStepStatus(outline, 1, "completed");
    expect(outline.steps[0].status).toBe("pending");
    expect(updated.steps[0].status).toBe("completed");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatOutline", () => {
  it("renders outline with steps and progress", () => {
    let outline = generateOutline("Build API, write tests, deploy");
    outline = updateStepStatus(outline, 1, "completed", "API built");

    const output = formatOutline(outline);
    expect(output).toContain("Execution Outline");
    expect(output).toContain("Build API");
    expect(output).toContain("1/3 completed");
    expect(output).toContain("✓");
    expect(output).toContain("○");
    expect(output).toContain("Read-only");
  });
});
