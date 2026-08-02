import { describe, it, expect } from "vitest";
import {
  ExecutionAuditTrail,
  formatAuditTrail,
} from "../../src/execution-audit.js";

// Pure-function coverage for execution audit trail (Issue #416): event
// recording, revision/attempt filtering, bounding, redaction, and
// determinism.

// --- event recording --------------------------------------------------------

describe("recordEvent", () => {
  it("records an event with revision and attempt", () => {
    const trail = new ExecutionAuditTrail();
    const event = trail.recordEvent("tool-call", 1, 1, "Called read_file", 1000);

    expect(event.type).toBe("tool-call");
    expect(event.goalRevision).toBe(1);
    expect(event.attempt).toBe(1);
    expect(event.description).toBe("Called read_file");
    expect(event.timestamp).toBe(1000);
  });

  it("redacts secrets in description", () => {
    const trail = new ExecutionAuditTrail();
    const event = trail.recordEvent("tool-call", 1, 1, "Deploy with --token=supersecretvalue123");

    expect(event.description).toContain("[REDACTED]");
    expect(event.description).not.toContain("supersecretvalue123");
  });

  it("bounds description at 300 chars", () => {
    const trail = new ExecutionAuditTrail();
    const event = trail.recordEvent("completion", 1, 1, "x".repeat(500));

    expect(event.description.length).toBeLessThanOrEqual(300);
  });
});

// --- revision filtering -----------------------------------------------------

describe("getEventsForRevision", () => {
  it("filters events by revision", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Event rev1", 1000);
    trail.recordEvent("tool-call", 2, 1, "Event rev2", 2000);
    trail.recordEvent("completion", 1, 1, "Done rev1", 3000);

    const rev1 = trail.getEventsForRevision(1);
    expect(rev1).toHaveLength(2);
    expect(rev1.every((e) => e.goalRevision === 1)).toBe(true);

    const rev2 = trail.getEventsForRevision(2);
    expect(rev2).toHaveLength(1);
  });

  it("returns empty for unknown revision", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Event", 1000);
    expect(trail.getEventsForRevision(99)).toHaveLength(0);
  });
});

// --- attempt filtering ------------------------------------------------------

describe("getEventsForAttempt", () => {
  it("filters events by revision and attempt", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Attempt 1", 1000);
    trail.recordEvent("retry", 1, 2, "Attempt 2", 2000);
    trail.recordEvent("tool-call", 1, 2, "Attempt 2 event", 3000);

    const attempt1 = trail.getEventsForAttempt(1, 1);
    expect(attempt1).toHaveLength(1);

    const attempt2 = trail.getEventsForAttempt(1, 2);
    expect(attempt2).toHaveLength(2);
  });
});

// --- type filtering ---------------------------------------------------------

describe("getEventsByType", () => {
  it("filters events by type", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Tool 1", 1000);
    trail.recordEvent("error", 1, 1, "Error 1", 2000);
    trail.recordEvent("tool-call", 1, 1, "Tool 2", 3000);

    const tools = trail.getEventsByType("tool-call");
    expect(tools).toHaveLength(2);

    const errors = trail.getEventsByType("error");
    expect(errors).toHaveLength(1);
  });
});

// --- bounding and eviction --------------------------------------------------

describe("bounding", () => {
  it("bounds events at 200", () => {
    const trail = new ExecutionAuditTrail();
    for (let i = 0; i < 210; i++) {
      trail.recordEvent("tool-call", 1, 1, `Event ${i}`, i * 1000);
    }

    expect(trail.size).toBeLessThanOrEqual(200);
  });

  it("evicts oldest events", () => {
    const trail = new ExecutionAuditTrail();
    for (let i = 0; i < 205; i++) {
      trail.recordEvent("tool-call", 1, 1, `Event ${i}`, i * 1000);
    }

    const events = trail.getAllEvents();
    // Oldest events should be evicted.
    expect(events[0].description).not.toBe("Event 0");
    expect(events[events.length - 1].description).toBe("Event 204");
  });
});

// --- copy isolation ---------------------------------------------------------

describe("copy isolation", () => {
  it("returns copies, not references", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Original", 1000);

    const events = trail.getAllEvents();
    events[0].description = "Modified";

    expect(trail.getAllEvents()[0].description).toBe("Original");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAuditTrail", () => {
  it("renders events with revision and attempt", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Called read_file", 1000);
    trail.recordEvent("completion", 1, 1, "Task completed", 2000);
    trail.recordEvent("error", 2, 1, "CI failed", 3000);

    const output = formatAuditTrail(trail);
    expect(output).toContain("Execution Audit Trail");
    expect(output).toContain("Events: 3");
    expect(output).toContain("[rev 1, attempt 1]");
    expect(output).toContain("[rev 2, attempt 1]");
    expect(output).toContain("Read-only");
  });

  it("is deterministic", () => {
    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Event", 1000);

    const a = formatAuditTrail(trail);
    const b = formatAuditTrail(trail);
    expect(a).toBe(b);
  });
});
