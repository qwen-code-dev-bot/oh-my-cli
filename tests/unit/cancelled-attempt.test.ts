import { describe, it, expect } from "vitest";
import {
  CancellationTracker,
  formatCancelledAttempt,
  formatCancellationTracker,
} from "../../src/cancelled-attempt.js";
import { ExecutionAuditTrail } from "../../src/execution-audit.js";

// Pure-function coverage for cancelled attempt (Issue #424): cancellation
// recording, event preservation, and determinism.

// --- cancellation recording -------------------------------------------------

describe("cancelAttempt", () => {
  it("records cancellation with actor and reason", () => {
    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 1, "user", "Changed my mind", undefined, 5000);

    expect(record.goalRevision).toBe(1);
    expect(record.attempt).toBe(1);
    expect(record.cancelledBy).toBe("user");
    expect(record.reason).toBe("Changed my mind");
    expect(record.cancelledAt).toBe(5000);
    expect(record.preservedEventCount).toBe(0);
  });

  it("preserves event count from audit trail", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Read file", 1000);
    trail.recordEvent("tool-call", 1, 1, "Write file", 2000);
    trail.recordEvent("error", 1, 1, "Failed", 3000);

    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 1, "user", "Too slow", trail, 5000);

    expect(record.preservedEventCount).toBe(3);
  });

  it("preserves events for specific attempt only", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Attempt 1 event", 1000);
    trail.recordEvent("tool-call", 1, 2, "Attempt 2 event", 2000);
    trail.recordEvent("error", 1, 2, "Attempt 2 error", 3000);

    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 2, "user", "Cancelling attempt 2", trail, 5000);

    expect(record.preservedEventCount).toBe(2); // Only attempt 2 events.
  });

  it("redacts secrets in reason", () => {
    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 1, "user", "Failed --token=supersecretvalue123");

    expect(record.reason).toContain("[REDACTED]");
    expect(record.reason).not.toContain("supersecretvalue123");
  });

  it("bounds reason at 200 chars", () => {
    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 1, "user", "x".repeat(500));

    expect(record.reason.length).toBeLessThanOrEqual(200);
  });
});

// --- querying ---------------------------------------------------------------

describe("getCancelledForRevision", () => {
  it("filters by revision", () => {
    const tracker = new CancellationTracker();
    tracker.cancelAttempt(1, 1, "user", "Cancelled rev 1", undefined, 1000);
    tracker.cancelAttempt(2, 1, "user", "Cancelled rev 2", undefined, 2000);

    const rev1 = tracker.getCancelledForRevision(1);
    expect(rev1).toHaveLength(1);
    expect(rev1[0].reason).toBe("Cancelled rev 1");

    const rev2 = tracker.getCancelledForRevision(2);
    expect(rev2).toHaveLength(1);
  });

  it("returns empty for unknown revision", () => {
    const tracker = new CancellationTracker();
    tracker.cancelAttempt(1, 1, "user", "Cancelled", undefined, 1000);
    expect(tracker.getCancelledForRevision(99)).toHaveLength(0);
  });
});

// --- copy isolation ---------------------------------------------------------

describe("copy isolation", () => {
  it("returns copies, not references", () => {
    const tracker = new CancellationTracker();
    tracker.cancelAttempt(1, 1, "user", "Original", undefined, 1000);

    const records = tracker.getAllCancelled();
    records[0].reason = "Modified";

    expect(tracker.getAllCancelled()[0].reason).toBe("Original");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatCancelledAttempt", () => {
  it("renders cancellation record", () => {
    const tracker = new CancellationTracker();
    const record = tracker.cancelAttempt(1, 2, "user", "Too slow", undefined, 5000);

    const output = formatCancelledAttempt(record);
    expect(output).toContain("⊘ Cancelled: rev 1, attempt 2");
    expect(output).toContain("By: user");
    expect(output).toContain("Reason: Too slow");
    expect(output).toContain("Preserved events: 0");
  });
});

describe("formatCancellationTracker", () => {
  it("renders all cancelled attempts", () => {
    const tracker = new CancellationTracker();
    tracker.cancelAttempt(1, 1, "user", "First cancel", undefined, 1000);
    tracker.cancelAttempt(1, 2, "agent", "Second cancel", undefined, 2000);

    const output = formatCancellationTracker(tracker);
    expect(output).toContain("Cancelled Attempts");
    expect(output).toContain("Total: 2");
    expect(output).toContain("First cancel");
    expect(output).toContain("Second cancel");
    expect(output).toContain("Read-only");
  });

  it("is deterministic", () => {
    const tracker = new CancellationTracker();
    tracker.cancelAttempt(1, 1, "user", "Cancel", undefined, 1000);

    const a = formatCancellationTracker(tracker);
    const b = formatCancellationTracker(tracker);
    expect(a).toBe(b);
  });
});
