import { describe, it, expect } from "vitest";
import {
  GoalRevisionHistory,
  safeObjective,
  safeTitle,
  safeReason,
  validateActor,
  deriveTitle,
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

// --- Goal title (Issue #395) ------------------------------------------------

describe("safeTitle", () => {
  it("bounds title at 80 chars", () => {
    const long = "x".repeat(200);
    const safe = safeTitle(long);
    expect(safe.length).toBeLessThanOrEqual(80);
  });

  it("redacts secrets in title", () => {
    const safe = safeTitle("Deploy with --token=supersecretvalue123");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("supersecretvalue123");
  });

  it("strips control characters", () => {
    const safe = safeTitle("hello\u0000world");
    expect(safe).not.toContain("\u0000");
  });
});

describe("deriveTitle", () => {
  it("auto-derives title from objective", () => {
    const title = deriveTitle("Build the REST API with authentication and rate limiting");
    expect(title).toBe("Build the REST API with authentication and rate limiting");
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("truncates long objectives to 80 chars", () => {
    const long = "A very long objective ".repeat(10);
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(80);
  });
});

describe("title in revisions", () => {
  it("auto-derives title when not provided", () => {
    const history = new GoalRevisionHistory();
    const entry = history.setObjective("Build the API", 1000);
    expect(entry.title).toBe("Build the API");
  });

  it("uses explicit title when provided", () => {
    const history = new GoalRevisionHistory();
    const entry = history.setObjective("Build the REST API with OAuth2 and rate limiting", 1000, "API OAuth2");
    expect(entry.title).toBe("API OAuth2");
    expect(entry.objective).toContain("OAuth2");
  });

  it("preserves title across revisions", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First objective", 1000, "My Goal");
    history.setObjective("Second objective", 2000, "My Goal");

    const r1 = history.getRevision(1)!;
    const r2 = history.getRevision(2)!;
    expect(r1.title).toBe("My Goal");
    expect(r2.title).toBe("My Goal");
  });

  it("updates title via setTitle", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build the API", 1000);
    history.setTitle("API Build", 2000);

    expect(history.getActive()!.title).toBe("API Build");
  });

  it("setTitle returns null when no active goal", () => {
    const history = new GoalRevisionHistory();
    expect(history.setTitle("Title")).toBeNull();
  });
});

describe("title in formatting", () => {
  it("shows title in goal status", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build the REST API with authentication", 1000, "Auth API");

    const output = formatGoalStatus(history);
    expect(output).toContain("title: Auth API");
    expect(output).toContain("objective: Build the REST API");
  });

  it("shows title in revision history", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("First objective", 1000, "Goal A");
    history.setObjective("Second objective", 2000, "Goal B");

    const output = formatRevisionHistory(history);
    expect(output).toContain("Goal A");
    expect(output).toContain("Goal B");
  });
});

// --- Transition reasons (Issue #397) ----------------------------------------

describe("safeReason", () => {
  it("bounds reason at 200 chars", () => {
    const long = "x".repeat(500);
    expect(safeReason(long).length).toBeLessThanOrEqual(200);
  });

  it("redacts secrets in reason", () => {
    const safe = safeReason("Failed because --token=supersecretvalue123 expired");
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("supersecretvalue123");
  });
});

describe("validateActor", () => {
  it("accepts valid actors", () => {
    expect(validateActor("user")).toBe("user");
    expect(validateActor("agent")).toBe("agent");
    expect(validateActor("system")).toBe("system");
  });

  it("defaults to system for unknown actors", () => {
    expect(validateActor("unknown")).toBe("system");
    expect(validateActor("")).toBe("system");
  });
});

describe("transition recording", () => {
  it("records actor and reason on status update", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("paused", 2000, "user", "Need to review first");

    const active = history.getActive()!;
    expect(active.status).toBe("paused");
    expect(active.transitionActor).toBe("user");
    expect(active.transitionReason).toBe("Need to review first");
  });

  it("works without actor/reason (backward compatible)", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("paused", 2000);

    const active = history.getActive()!;
    expect(active.transitionActor).toBeUndefined();
    expect(active.transitionReason).toBeUndefined();
  });

  it("validates actor enum", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("achieved", 2000, "invalid-actor", "Done");

    expect(history.getActive()!.transitionActor).toBe("system");
  });
});

describe("transition formatting", () => {
  it("shows transition in goal status", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("paused", 2000, "user", "Reviewing PRs");

    const output = formatGoalStatus(history);
    expect(output).toContain("transition: user");
    expect(output).toContain("Reviewing PRs");
  });

  it("shows unknown for backward-compatible revisions", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);

    const output = formatGoalStatus(history);
    expect(output).toContain("transition: unknown");
  });

  it("shows actor/reason in revision history", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("paused", 2000, "agent", "Blocked by CI failure");

    const output = formatRevisionHistory(history);
    expect(output).toContain("by: agent");
    expect(output).toContain("Blocked by CI failure");
  });
});
