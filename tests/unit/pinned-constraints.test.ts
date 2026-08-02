import { describe, it, expect } from "vitest";
import {
  PinnedConstraintTracker,
  formatPinnedConstraints,
} from "../../src/pinned-constraints.js";

// Pure-function coverage for pinned constraints (Issue #432): pin/unpin
// operations, bounding, redaction, and determinism.

// --- add constraint ---------------------------------------------------------

describe("addConstraint", () => {
  it("adds an unpinned constraint", () => {
    const tracker = new PinnedConstraintTracker();
    const constraint = tracker.addConstraint("Use OAuth2 flow", "user", 1, 1000);

    expect(constraint.text).toBe("Use OAuth2 flow");
    expect(constraint.pinned).toBe(false);
    expect(constraint.addedBy).toBe("user");
    expect(tracker.size).toBe(1);
    expect(tracker.pinnedCount).toBe(0);
  });

  it("redacts secrets in constraint text", () => {
    const tracker = new PinnedConstraintTracker();
    const constraint = tracker.addConstraint("Use --token=supersecretvalue123", "user", 1);

    expect(constraint.text).toContain("[REDACTED]");
    expect(constraint.text).not.toContain("supersecretvalue123");
  });

  it("bounds constraint text at 300 chars", () => {
    const tracker = new PinnedConstraintTracker();
    const constraint = tracker.addConstraint("x".repeat(500), "user", 1);

    expect(constraint.text.length).toBeLessThanOrEqual(300);
  });
});

// --- pin/unpin operations ---------------------------------------------------

describe("pinConstraint", () => {
  it("pins a constraint", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Use OAuth2", "user", 1, 1000);
    const pinned = tracker.pinConstraint(0, 5000);

    expect(pinned).not.toBeNull();
    expect(pinned!.pinned).toBe(true);
    expect(pinned!.pinnedAt).toBe(5000);
    expect(tracker.pinnedCount).toBe(1);
  });

  it("returns null for invalid index", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Test", "user", 1);

    expect(tracker.pinConstraint(-1)).toBeNull();
    expect(tracker.pinConstraint(99)).toBeNull();
  });

  it("bounds pinned at 10", () => {
    const tracker = new PinnedConstraintTracker();
    for (let i = 0; i < 12; i++) {
      tracker.addConstraint(`Constraint ${i}`, "user", 1, i * 1000);
    }
    for (let i = 0; i < 12; i++) {
      tracker.pinConstraint(i, i * 1000);
    }

    expect(tracker.pinnedCount).toBe(10);
    expect(tracker.isPinnedFull).toBe(true);
  });
});

describe("unpinConstraint", () => {
  it("unpins a constraint", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Use OAuth2", "user", 1, 1000);
    tracker.pinConstraint(0, 5000);
    const unpinned = tracker.unpinConstraint(0);

    expect(unpinned).not.toBeNull();
    expect(unpinned!.pinned).toBe(false);
    expect(unpinned!.pinnedAt).toBeUndefined();
    expect(tracker.pinnedCount).toBe(0);
  });

  it("returns null for invalid index", () => {
    const tracker = new PinnedConstraintTracker();
    expect(tracker.unpinConstraint(0)).toBeNull();
  });
});

// --- querying ---------------------------------------------------------------

describe("getPinnedConstraints", () => {
  it("returns only pinned constraints", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Pinned", "user", 1, 1000);
    tracker.addConstraint("Not pinned", "user", 1, 2000);
    tracker.pinConstraint(0, 5000);

    const pinned = tracker.getPinnedConstraints();
    expect(pinned).toHaveLength(1);
    expect(pinned[0].text).toBe("Pinned");
  });

  it("returns copies, not references", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Test", "user", 1, 1000);
    tracker.pinConstraint(0, 5000);

    const pinned = tracker.getPinnedConstraints();
    pinned[0].text = "Modified";

    expect(tracker.getPinnedConstraints()[0].text).toBe("Test");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatPinnedConstraints", () => {
  it("renders constraints with pin indicators", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Use OAuth2", "user", 1, 1000);
    tracker.addConstraint("Target Node 20+", "user", 1, 2000);
    tracker.pinConstraint(0, 5000);

    const output = formatPinnedConstraints(tracker);
    expect(output).toContain("2 total, 1 pinned/10 max");
    expect(output).toContain("📌");
    expect(output).toContain("Use OAuth2");
    expect(output).toContain("Target Node 20+");
  });

  it("shows capacity warning when pinned full", () => {
    const tracker = new PinnedConstraintTracker();
    for (let i = 0; i < 10; i++) {
      tracker.addConstraint(`Constraint ${i}`, "user", 1, i * 1000);
      tracker.pinConstraint(i, i * 1000);
    }

    const output = formatPinnedConstraints(tracker);
    expect(output).toContain("Pinned at capacity");
  });

  it("is deterministic", () => {
    const tracker = new PinnedConstraintTracker();
    tracker.addConstraint("Test", "user", 1, 1000);

    const a = formatPinnedConstraints(tracker);
    const b = formatPinnedConstraints(tracker);
    expect(a).toBe(b);
  });
});
