import { describe, it, expect } from "vitest";
import {
  GoalRevisionHistory,
  safeObjective,
  formatGoalStatus,
  formatRevisionHistory,
} from "../../src/goal-revision.js";

// Pure-function coverage for Goal revision history (Issue #289): revision
// creation, history ordering, active-revision identification, redaction,
// status updates, and formatting.

// --- revision creation ------------------------------------------------------

describe("revision creation", () => {
  it("creates a new revision with incremented number", () => {
    const history = new GoalRevisionHistory();
    const r1 = history.setObjective("Build the API", 1000);

    expect(r1.revision).toBe(1);
    expect(r1.objective).toBe("Build the API");
    expect(r1.status).toBe("active");
    expect(r1.isActive).toBe(true);
  });

  it("preserves prior revisions when setting a new objective", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First objective", 1000);
    history.setObjective("Second objective", 2000);

    expect(history.size).toBe(2);
    expect(history.revision).toBe(2);

    const r1 = history.getRevision(1)!;
    expect(r1.objective).toBe("First objective");
    expect(r1.isActive).toBe(false);

    const r2 = history.getRevision(2)!;
    expect(r2.objective).toBe("Second objective");
    expect(r2.isActive).toBe(true);
  });

  it("deactivates prior active revision", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First", 1000);
    history.setObjective("Second", 2000);

    const active = history.getActive();
    expect(active!.revision).toBe(2);
    expect(active!.objective).toBe("Second");
  });
});

// --- history ordering -------------------------------------------------------

describe("history ordering", () => {
  it("lists revisions in order", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("A", 1000);
    history.setObjective("B", 2000);
    history.setObjective("C", 3000);

    const list = history.list();
    expect(list).toHaveLength(3);
    expect(list[0].revision).toBe(1);
    expect(list[1].revision).toBe(2);
    expect(list[2].revision).toBe(3);
  });

  it("bounds revision history", () => {
    const history = new GoalRevisionHistory();
    for (let i = 0; i < 60; i++) {
      history.setObjective(`Objective ${i}`, i * 1000);
    }

    expect(history.size).toBeLessThanOrEqual(50);
  });
});

// --- active revision identification -----------------------------------------

describe("active revision identification", () => {
  it("identifies the active revision", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First", 1000);
    history.setObjective("Second", 2000);

    const active = history.getActive();
    expect(active).not.toBeNull();
    expect(active!.isActive).toBe(true);
    expect(active!.revision).toBe(2);
  });

  it("returns null when no active goal", () => {
    const history = new GoalRevisionHistory();
    expect(history.getActive()).toBeNull();
  });
});

// --- status updates ---------------------------------------------------------

describe("status updates", () => {
  it("pauses the active revision", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Test", 1000);
    history.updateStatus("paused", 2000);

    expect(history.getActive()!.status).toBe("paused");
    expect(history.getActive()!.updatedAt).toBe(2000);
  });

  it("achieves the active revision", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Test", 1000);
    history.updateStatus("achieved", 2000);

    expect(history.getActive()!.status).toBe("achieved");
  });

  it("returns null when no active goal", () => {
    const history = new GoalRevisionHistory();
    expect(history.updateStatus("paused")).toBeNull();
  });
});

// --- redaction and bounding -------------------------------------------------

describe("redaction and bounding", () => {
  it("redacts secrets in objectives", () => {
    const safe = safeObjective("Deploy with --token=supersecretvalue123");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("supersecretvalue123");
  });

  it("bounds long objectives", () => {
    const long = "x".repeat(1000);
    const safe = safeObjective(long);
    expect(safe.length).toBeLessThanOrEqual(500);
  });

  it("strips control characters", () => {
    const safe = safeObjective("hello\u0000world\u001ftest");
    expect(safe).not.toContain("\u0000");
    expect(safe).not.toContain("\u001f");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatGoalStatus", () => {
  it("formats active goal with revision info", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build feature", 1000);

    const output = formatGoalStatus(history);
    expect(output).toContain("Goal: active");
    expect(output).toContain("Build feature");
    expect(output).toContain("revision: 1");
    expect(output).toContain("history: 1 revision(s)");
  });

  it("formats empty goal", () => {
    const history = new GoalRevisionHistory();
    const output = formatGoalStatus(history);
    expect(output).toContain("Goal: none");
  });
});

describe("formatRevisionHistory", () => {
  it("renders revision history with active identified", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First", 1000);
    history.setObjective("Second", 2000);
    history.updateStatus("paused", 3000);

    const output = formatRevisionHistory(history);
    expect(output).toContain("Goal Revision History");
    expect(output).toContain("rev 1");
    expect(output).toContain("rev 2");
    expect(output).toContain("●"); // Active marker
    expect(output).toContain("○"); // Inactive marker
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("formatting does not modify history", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Test", 1000);

    const before = history.size;
    formatGoalStatus(history);
    formatRevisionHistory(history);
    expect(history.size).toBe(before);
  });
});
