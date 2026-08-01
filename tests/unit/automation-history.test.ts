import { describe, it, expect } from "vitest";
import {
  AutomationTracker,
  formatScheduleEntry,
  formatTrackerSummary,
  type RunEntry,
} from "../../src/automation-history.js";

// Pure-function coverage for automation history (Issue #373): schedule
// state, run outcomes, consecutive failures, multi-schedule, missed-run
// fixtures, and read-only guarantee.

function run(id: string, outcome: RunEntry["outcome"], overrides: Partial<RunEntry> = {}): RunEntry {
  return { id, outcome, startedAt: Date.now(), durationMs: 1000, ...overrides };
}

// --- schedule state ---------------------------------------------------------

describe("schedule state", () => {
  it("registers a schedule with default enabled state", () => {
    const tracker = new AutomationTracker();
    const schedule = tracker.register({
      id: "dep-review",
      name: "Dependency review",
      triggerType: "interval",
      expression: "0 9 * * 1",
    });

    expect(schedule.state).toBe("enabled");
    expect(schedule.consecutiveFailures).toBe(0);
    expect(schedule.needsAttention).toBe(false);
  });

  it("registers with explicit state", () => {
    const tracker = new AutomationTracker();
    const schedule = tracker.register({
      id: "s1",
      name: "Paused schedule",
      triggerType: "calendar",
      expression: "0 0 * * *",
      state: "paused",
    });

    expect(schedule.state).toBe("paused");
  });
});

// --- run outcomes -----------------------------------------------------------

describe("run outcomes", () => {
  it("records runs and tracks last run time", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "success", { startedAt: 5000 }));

    const schedule = tracker.get("s1")!;
    expect(schedule.runs).toHaveLength(1);
    expect(schedule.lastRunAt).toBe(5000);
  });

  it("resets consecutive failures on success", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "failure"));
    tracker.recordRun("s1", run("r2", "failure"));
    tracker.recordRun("s1", run("r3", "success"));

    expect(tracker.get("s1")!.consecutiveFailures).toBe(0);
  });

  it("does not reset on skipped", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "failure"));
    tracker.recordRun("s1", run("r2", "skipped"));

    expect(tracker.get("s1")!.consecutiveFailures).toBe(1);
  });

  it("bounds run history", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/1 * * * *" });

    for (let i = 0; i < 60; i++) {
      tracker.recordRun("s1", run(`r${i}`, "success"));
    }

    expect(tracker.get("s1")!.runs.length).toBeLessThanOrEqual(50);
  });
});

// --- consecutive failures ---------------------------------------------------

describe("consecutive failures", () => {
  it("flags needsAttention at 3 consecutive failures", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Flaky", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "failure"));
    tracker.recordRun("s1", run("r2", "failure"));
    expect(tracker.get("s1")!.needsAttention).toBe(false);

    tracker.recordRun("s1", run("r3", "failure"));
    expect(tracker.get("s1")!.needsAttention).toBe(true);
    expect(tracker.get("s1")!.consecutiveFailures).toBe(3);
  });

  it("counts missed runs as failures", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "missed"));
    tracker.recordRun("s1", run("r2", "missed"));
    tracker.recordRun("s1", run("r3", "missed"));

    expect(tracker.get("s1")!.needsAttention).toBe(true);
  });
});

// --- multi-schedule fixture -------------------------------------------------

describe("multi-schedule fixture", () => {
  it("tracks multiple schedules independently", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Dep review", triggerType: "calendar", expression: "0 9 * * 1" });
    tracker.register({ id: "s2", name: "Health check", triggerType: "interval", expression: "*/30 * * * *" });
    tracker.register({ id: "s3", name: "Release prep", triggerType: "event", expression: "tag:*" });

    tracker.recordRun("s1", run("r1", "success"));
    tracker.recordRun("s2", run("r2", "failure"));
    tracker.recordRun("s2", run("r3", "failure"));
    tracker.recordRun("s2", run("r4", "failure"));

    expect(tracker.size).toBe(3);
    expect(tracker.getNeedingAttention()).toHaveLength(1);
    expect(tracker.getNeedingAttention()[0].id).toBe("s2");
    expect(tracker.getEnabled()).toHaveLength(3);
  });
});

// --- queries ----------------------------------------------------------------

describe("queries", () => {
  it("filters enabled schedules", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Active", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.register({ id: "s2", name: "Paused", triggerType: "interval", expression: "*/5 * * * *", state: "paused" });

    expect(tracker.getEnabled()).toHaveLength(1);
    expect(tracker.getEnabled()[0].id).toBe("s1");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("renders schedule with runs and attention flag", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Flaky job", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "failure", { errorSummary: "Timeout after 30s" }));
    tracker.recordRun("s1", run("r2", "failure"));
    tracker.recordRun("s1", run("r3", "failure"));

    const output = formatScheduleEntry(tracker.get("s1")!);
    expect(output).toContain("Flaky job");
    expect(output).toContain("NEEDS ATTENTION");
    expect(output).toContain("Consecutive failures: 3");
    expect(output).toContain("Timeout after 30s");
  });

  it("renders tracker summary", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Job", triggerType: "interval", expression: "*/5 * * * *" });

    const output = formatTrackerSummary(tracker);
    expect(output).toContain("Automation History");
    expect(output).toContain("Schedules: 1");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("tracking does not execute or modify schedules", () => {
    const tracker = new AutomationTracker();
    tracker.register({ id: "s1", name: "Test", triggerType: "interval", expression: "*/5 * * * *" });
    tracker.recordRun("s1", run("r1", "success"));

    // Pure data model — no side effects.
    expect(tracker.get("s1")!.state).toBe("enabled");
  });
});
