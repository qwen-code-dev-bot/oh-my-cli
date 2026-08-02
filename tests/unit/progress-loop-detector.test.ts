import { describe, it, expect } from "vitest";
import {
  ProgressTracker,
  formatNoProgressWarning,
} from "../../src/progress-loop-detector.js";

// Pure-function coverage for progress loop detector (Issue #450): loop
// detection, threshold handling, warning formatting, and determinism.

// --- loop detection ---------------------------------------------------------

describe("loop detection", () => {
  it("does not detect loop below threshold", () => {
    const tracker = new ProgressTracker(3);
    const w1 = tracker.recordAttempt("step-1");
    const w2 = tracker.recordAttempt("step-1");

    expect(w1.loopDetected).toBe(false);
    expect(w2.loopDetected).toBe(false);
    expect(w2.attemptCount).toBe(2);
  });

  it("detects loop at threshold", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    const w3 = tracker.recordAttempt("step-1");

    expect(w3.loopDetected).toBe(true);
    expect(w3.attemptCount).toBe(3);
    expect(w3.stuckStep).toBe("step-1");
    expect(w3.message).toContain("No progress detected");
  });

  it("continues detecting above threshold", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    const w4 = tracker.recordAttempt("step-1");

    expect(w4.loopDetected).toBe(true);
    expect(w4.attemptCount).toBe(4);
  });

  it("resets on step advancement", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    tracker.advanceTo("step-2");

    expect(tracker.attemptCount).toBe(0);
    expect(tracker.currentStepName).toBe("step-2");

    const w = tracker.recordAttempt("step-2");
    expect(w.attemptCount).toBe(1);
    expect(w.loopDetected).toBe(false);
  });

  it("resets on different step attempt", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    const w = tracker.recordAttempt("step-2"); // Different step resets.

    expect(w.attemptCount).toBe(1);
    expect(w.loopDetected).toBe(false);
  });
});

// --- threshold handling -----------------------------------------------------

describe("threshold handling", () => {
  it("supports custom threshold", () => {
    const tracker = new ProgressTracker(5);
    for (let i = 0; i < 4; i++) {
      const w = tracker.recordAttempt("step-1");
      expect(w.loopDetected).toBe(false);
    }
    const w5 = tracker.recordAttempt("step-1");
    expect(w5.loopDetected).toBe(true);
    expect(w5.threshold).toBe(5);
  });

  it("uses default threshold of 3", () => {
    const tracker = new ProgressTracker();
    tracker.recordAttempt("step-1");
    tracker.recordAttempt("step-1");
    const w = tracker.recordAttempt("step-1");

    expect(w.threshold).toBe(3);
    expect(w.loopDetected).toBe(true);
  });
});

// --- warning formatting -----------------------------------------------------

describe("formatNoProgressWarning", () => {
  it("renders loop detected warning", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("deploy");
    tracker.recordAttempt("deploy");
    const warning = tracker.recordAttempt("deploy");

    const output = formatNoProgressWarning(warning);
    expect(output).toContain("LOOP DETECTED");
    expect(output).toContain("⚠");
    expect(output).toContain("Step: deploy");
    expect(output).toContain("Attempts: 3/3");
    expect(output).toContain("No progress detected");
  });

  it("renders in-progress status", () => {
    const tracker = new ProgressTracker(3);
    const warning = tracker.recordAttempt("build");

    const output = formatNoProgressWarning(warning);
    expect(output).toContain("IN PROGRESS");
    expect(output).toContain("○");
    expect(output).toContain("Attempts: 1/3");
  });

  it("is deterministic", () => {
    const tracker = new ProgressTracker(3);
    tracker.recordAttempt("step");
    tracker.recordAttempt("step");
    const warning = tracker.recordAttempt("step");

    const a = formatNoProgressWarning(warning);
    const b = formatNoProgressWarning(warning);
    expect(a).toBe(b);
  });
});
