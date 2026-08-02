import { describe, it, expect } from "vitest";
import {
  buildCompletionSummary,
  formatCompletionSummary,
} from "../../src/completion-summary.js";
import { GoalRevisionHistory } from "../../src/goal-revision.js";
import { ExecutionAuditTrail } from "../../src/execution-audit.js";

// Pure-function coverage for completion summary (Issue #420): summary
// derivation, formatting, and determinism.

// --- summary derivation -----------------------------------------------------

describe("buildCompletionSummary", () => {
  it("builds summary for achieved Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build the API", 1000, "API Build");
    history.updateStatus("achieved", 5000, "agent", "All tests pass");

    const summary = buildCompletionSummary(history);

    expect(summary.outcome).toBe("achieved");
    expect(summary.terminalState).toBe("achieved");
    expect(summary.objective).toBe("Build the API");
    expect(summary.title).toBe("API Build");
    expect(summary.totalRevisions).toBe(1);
    expect(summary.finalRevision).toBe(1);
    expect(summary.durationMs).toBe(4000);
    expect(summary.finalActor).toBe("agent");
    expect(summary.finalReason).toBe("All tests pass");
  });

  it("builds summary for failed Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy to prod", 1000);
    history.updateStatus("failed", 3000, "agent", "CI failed");

    const summary = buildCompletionSummary(history);
    expect(summary.outcome).toBe("failed");
    expect(summary.terminalState).toBe("failed");
  });

  it("builds summary for cancelled Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Refactor auth", 1000);
    history.updateStatus("cancelled", 2000, "user", "No longer needed");

    const summary = buildCompletionSummary(history);
    expect(summary.outcome).toBe("cancelled");
  });

  it("builds summary for superseded Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build v1", 1000);
    history.updateStatus("superseded", 2000, "user", "Replaced by v2");

    const summary = buildCompletionSummary(history);
    expect(summary.outcome).toBe("superseded");
  });

  it("handles incomplete Goal (active)", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build the API", 1000);

    const summary = buildCompletionSummary(history);
    expect(summary.outcome).toBe("incomplete");
    expect(summary.terminalState).toBe("active");
  });

  it("handles empty history", () => {
    const history = new GoalRevisionHistory();
    const summary = buildCompletionSummary(history);

    expect(summary.outcome).toBe("incomplete");
    expect(summary.totalRevisions).toBe(0);
    expect(summary.objective).toBe("(no objective)");
  });

  it("includes audit trail event counts", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("achieved", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Read file", 1000);
    trail.recordEvent("tool-call", 1, 1, "Write file", 2000);
    trail.recordEvent("completion", 1, 1, "Done", 3000);

    const summary = buildCompletionSummary(history, trail);
    expect(summary.totalEvents).toBe(3);
    expect(summary.eventCounts["tool-call"]).toBe(2);
    expect(summary.eventCounts["completion"]).toBe(1);
    expect(summary.estimatedTokens).toBeGreaterThan(0);
  });

  it("handles multiple revisions", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build v1", 1000);
    history.updateStatus("failed", 2000);
    history.setObjective("Build v2", 3000);
    history.updateStatus("achieved", 5000);

    const summary = buildCompletionSummary(history);
    expect(summary.totalRevisions).toBe(2);
    expect(summary.finalRevision).toBe(2);
    expect(summary.outcome).toBe("achieved");
    expect(summary.durationMs).toBe(4000); // 5000 - 1000
  });
});

// --- formatting -------------------------------------------------------------

describe("formatCompletionSummary", () => {
  it("renders achieved summary", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build the API", 1000, "API Build");
    history.updateStatus("achieved", 5000, "agent", "All tests pass");

    const summary = buildCompletionSummary(history);
    const output = formatCompletionSummary(summary);

    expect(output).toContain("Goal Completion Summary");
    expect(output).toContain("API Build");
    expect(output).toContain("Build the API");
    expect(output).toContain("✓ Achieved");
    expect(output).toContain("Revisions: 1");
    expect(output).toContain("4s");
    expect(output).toContain("agent");
  });

  it("renders failed summary with reason", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 2000, "agent", "CI timeout");

    const output = formatCompletionSummary(buildCompletionSummary(history));
    expect(output).toContain("✗ Failed");
    expect(output).toContain("CI timeout");
  });

  it("renders event counts", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("achieved", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Read", 1000);
    trail.recordEvent("error", 1, 1, "Fail", 2000);

    const output = formatCompletionSummary(buildCompletionSummary(history, trail));
    expect(output).toContain("Events: 2");
    expect(output).toContain("tool-call:1");
    expect(output).toContain("error:1");
  });

  it("is deterministic", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("achieved", 5000);

    const summary = buildCompletionSummary(history);
    const a = formatCompletionSummary(summary);
    const b = formatCompletionSummary(summary);
    expect(a).toBe(b);
  });
});
