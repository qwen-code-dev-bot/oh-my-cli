import { describe, it, expect } from "vitest";
import {
  GoalConstraintTracker,
  formatConstraints,
} from "../../src/goal-constraints.js";

// Pure-function coverage for Goal constraints (Issue #426): constraint
// appending, bounding, redaction, and determinism.

// --- constraint appending ---------------------------------------------------

describe("addConstraint", () => {
  it("appends a constraint", () => {
    const tracker = new GoalConstraintTracker();
    const constraint = tracker.addConstraint("Use OAuth2 flow, not basic", "user", 1, 1000);

    expect(constraint).not.toBeNull();
    expect(constraint!.text).toBe("Use OAuth2 flow, not basic");
    expect(constraint!.addedBy).toBe("user");
    expect(constraint!.revision).toBe(1);
    expect(constraint!.addedAt).toBe(1000);
    expect(tracker.size).toBe(1);
  });

  it("appends multiple constraints", () => {
    const tracker = new GoalConstraintTracker();
    tracker.addConstraint("Use OAuth2", "user", 1, 1000);
    tracker.addConstraint("Target Node 20+", "user", 1, 2000);
    tracker.addConstraint("No external dependencies", "user", 2, 3000);

    expect(tracker.size).toBe(3);
  });

  it("redacts secrets in constraint text", () => {
    const tracker = new GoalConstraintTracker();
    const constraint = tracker.addConstraint("Use --token=supersecretvalue123 for auth", "user", 1);

    expect(constraint!.text).toContain("[REDACTED]");
    expect(constraint!.text).not.toContain("supersecretvalue123");
  });

  it("bounds constraint text at 300 chars", () => {
    const tracker = new GoalConstraintTracker();
    const constraint = tracker.addConstraint("x".repeat(500), "user", 1);

    expect(constraint!.text.length).toBeLessThanOrEqual(300);
  });
});

// --- bounding ---------------------------------------------------------------

describe("bounding", () => {
  it("bounds at 20 constraints", () => {
    const tracker = new GoalConstraintTracker();
    for (let i = 0; i < 25; i++) {
      tracker.addConstraint(`Constraint ${i}`, "user", 1, i * 1000);
    }

    expect(tracker.size).toBe(20);
    expect(tracker.isFull).toBe(true);
  });

  it("returns null when at capacity", () => {
    const tracker = new GoalConstraintTracker();
    for (let i = 0; i < 20; i++) {
      tracker.addConstraint(`Constraint ${i}`, "user", 1, i * 1000);
    }

    const result = tracker.addConstraint("One more", "user", 1);
    expect(result).toBeNull();
    expect(tracker.size).toBe(20);
  });
});

// --- querying ---------------------------------------------------------------

describe("getConstraints", () => {
  it("returns all constraints as copies", () => {
    const tracker = new GoalConstraintTracker();
    tracker.addConstraint("Constraint A", "user", 1, 1000);
    tracker.addConstraint("Constraint B", "agent", 2, 2000);

    const constraints = tracker.getConstraints();
    expect(constraints).toHaveLength(2);

    // Modifying the copy doesn't affect the tracker.
    constraints[0].text = "Modified";
    expect(tracker.getConstraints()[0].text).toBe("Constraint A");
  });
});

describe("getConstraintsForRevision", () => {
  it("filters by revision", () => {
    const tracker = new GoalConstraintTracker();
    tracker.addConstraint("Rev 1 constraint", "user", 1, 1000);
    tracker.addConstraint("Rev 2 constraint", "user", 2, 2000);
    tracker.addConstraint("Another rev 1", "user", 1, 3000);

    const rev1 = tracker.getConstraintsForRevision(1);
    expect(rev1).toHaveLength(2);

    const rev2 = tracker.getConstraintsForRevision(2);
    expect(rev2).toHaveLength(1);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatConstraints", () => {
  it("renders constraints with metadata", () => {
    const tracker = new GoalConstraintTracker();
    tracker.addConstraint("Use OAuth2", "user", 1, 1000);
    tracker.addConstraint("Target Node 20+", "agent", 2, 2000);

    const output = formatConstraints(tracker);
    expect(output).toContain("Goal Constraints (2/20)");
    expect(output).toContain("Use OAuth2");
    expect(output).toContain("by user at rev 1");
    expect(output).toContain("Target Node 20+");
    expect(output).toContain("by agent at rev 2");
  });

  it("shows capacity warning when full", () => {
    const tracker = new GoalConstraintTracker();
    for (let i = 0; i < 20; i++) {
      tracker.addConstraint(`Constraint ${i}`, "user", 1, i * 1000);
    }

    const output = formatConstraints(tracker);
    expect(output).toContain("At capacity");
  });

  it("is deterministic", () => {
    const tracker = new GoalConstraintTracker();
    tracker.addConstraint("Test", "user", 1, 1000);

    const a = formatConstraints(tracker);
    const b = formatConstraints(tracker);
    expect(a).toBe(b);
  });
});
