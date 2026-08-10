import { describe, it, expect } from "vitest";
import {
  deriveStepProgress,
  renderProgressBar,
  formatStepProgress,
} from "../../src/step-progress.js";
import { generateOutline, updateStepStatus } from "../../src/execution-outline.js";

// Pure-function coverage for step progress (Issue #407): progress
// derivation, percentage calculation, formatting, and determinism.

// --- progress derivation ----------------------------------------------------

describe("deriveStepProgress", () => {
  it("derives progress from a fresh outline", () => {
    const outline = generateOutline("Step A, step B, step C");
    const progress = deriveStepProgress(outline);

    expect(progress.total).toBe(3);
    expect(progress.pending).toBe(3);
    expect(progress.completed).toBe(0);
    expect(progress.inProgress).toBe(0);
    expect(progress.blocked).toBe(0);
    expect(progress.skipped).toBe(0);
    expect(progress.progressPct).toBe(0);
    expect(progress.currentStep).toBeNull();
    expect(progress.isDone).toBe(false);
    expect(progress.hasBlocked).toBe(false);
  });

  it("tracks completed steps", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");

    const progress = deriveStepProgress(outline);
    expect(progress.completed).toBe(2);
    expect(progress.pending).toBe(1);
    expect(progress.progressPct).toBe(67); // 2/3 = 67%
  });

  it("identifies current step", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "in-progress");

    const progress = deriveStepProgress(outline);
    expect(progress.currentStep).not.toBeNull();
    expect(progress.currentStep!.id).toBe(2);
    expect(progress.inProgress).toBe(1);
  });

  it("tracks blocked (failed) steps", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "failed", "CI error");

    const progress = deriveStepProgress(outline);
    expect(progress.blocked).toBe(1);
    expect(progress.hasBlocked).toBe(true);
  });

  it("tracks skipped steps", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 2, "skipped");

    const progress = deriveStepProgress(outline);
    expect(progress.skipped).toBe(1);
    // Skipped counts as done for progress percentage.
    expect(progress.progressPct).toBe(33); // 1/3
  });

  it("detects all-done state", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");

    const progress = deriveStepProgress(outline);
    expect(progress.isDone).toBe(true);
    expect(progress.progressPct).toBe(100);
  });

  it("handles single-step outline", () => {
    const outline = generateOutline("Fix the bug");
    const progress = deriveStepProgress(outline);

    expect(progress.total).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.progressPct).toBe(0);
  });

  it("is deterministic", () => {
    let outline = generateOutline("Step A, step B, step C");
    outline = updateStepStatus(outline, 1, "completed");

    const a = deriveStepProgress(outline);
    const b = deriveStepProgress(outline);
    expect(a.progressPct).toBe(b.progressPct);
    expect(a.completed).toBe(b.completed);
  });
});

// --- progress bar -----------------------------------------------------------

describe("renderProgressBar", () => {
  it("renders 0%", () => {
    const bar = renderProgressBar(0);
    expect(bar).toBe("[░░░░░░░░░░░░░░░░░░░░]");
  });

  it("renders 100%", () => {
    const bar = renderProgressBar(100);
    expect(bar).toBe("[████████████████████]");
  });

  it("renders 50%", () => {
    const bar = renderProgressBar(50);
    expect(bar).toContain("█");
    expect(bar).toContain("░");
    expect(bar.length).toBe(22); // 20 chars + 2 brackets
  });

  it("clamps over-100% to a full bar instead of throwing (Issue #808)", () => {
    expect(() => renderProgressBar(150)).not.toThrow();
    expect(renderProgressBar(150)).toBe("[████████████████████]");
  });

  it("clamps negative pct to an empty bar instead of throwing (Issue #808)", () => {
    expect(() => renderProgressBar(-10)).not.toThrow();
    expect(renderProgressBar(-10)).toBe("[░░░░░░░░░░░░░░░░░░░░]");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatStepProgress", () => {
  it("renders progress with current step", () => {
    let outline = generateOutline("Build API, write tests, deploy");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "in-progress");

    const progress = deriveStepProgress(outline);
    const output = formatStepProgress(progress);

    expect(output).toContain("Progress:");
    expect(output).toContain("33%");
    expect(output).toContain("Current: 2. write tests");
    expect(output).toContain("1✓");
  });

  it("shows blocked warning", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "failed");

    const output = formatStepProgress(deriveStepProgress(outline));
    expect(output).toContain("⚠ Blocked steps detected");
  });

  it("shows all-complete message", () => {
    let outline = generateOutline("Step A, step B");
    outline = updateStepStatus(outline, 1, "completed");
    outline = updateStepStatus(outline, 2, "completed");

    const output = formatStepProgress(deriveStepProgress(outline));
    expect(output).toContain("✓ All steps complete");
    expect(output).toContain("100%");
  });
});
