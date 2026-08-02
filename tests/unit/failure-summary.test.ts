import { describe, it, expect } from "vitest";
import {
  buildFailureSummary,
  formatFailureSummary,
} from "../../src/failure-summary.js";
import { GoalRevisionHistory } from "../../src/goal-revision.js";
import { ExecutionAuditTrail } from "../../src/execution-audit.js";

// Pure-function coverage for failure summary (Issue #422): failure
// derivation, diagnostic preservation, suggestion generation, and
// determinism.

// --- failure derivation -----------------------------------------------------

describe("buildFailureSummary", () => {
  it("builds summary for failed Goal with error events", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy to production", 1000, "Prod Deploy");
    history.updateStatus("failed", 5000, "agent", "CI failed");

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("tool-call", 1, 1, "Run tests", 2000);
    trail.recordEvent("error", 1, 1, "Test timeout after 30s", 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary).not.toBeNull();
    expect(summary!.objective).toBe("Deploy to production");
    expect(summary!.title).toBe("Prod Deploy");
    expect(summary!.failedRevision).toBe(1);
    expect(summary!.failedAttempt).toBe(1);
    expect(summary!.failedStepDescription).toBe("Test timeout after 30s");
    expect(summary!.diagnostic).toBe("Test timeout after 30s");
    expect(summary!.eventsBeforeFailure).toBe(1);
  });

  it("returns null for non-failed Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("achieved", 5000);

    expect(buildFailureSummary(history)).toBeNull();
  });

  it("returns null for active Goal", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);

    expect(buildFailureSummary(history)).toBeNull();
  });

  it("handles failed Goal without audit trail", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Build API", 1000);
    history.updateStatus("failed", 5000, "agent", "Unknown error");

    const summary = buildFailureSummary(history);
    expect(summary).not.toBeNull();
    expect(summary!.failedStepDescription).toContain("Unknown failure");
    expect(summary!.diagnostic).toContain("No diagnostic");
  });

  it("redacts secrets in diagnostic", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("error", 1, 1, "Auth failed --token=supersecretvalue123", 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary!.diagnostic).toContain("[REDACTED]");
    expect(summary!.diagnostic).not.toContain("supersecretvalue123");
  });

  it("bounds diagnostic at 300 chars", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("error", 1, 1, "x".repeat(500), 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary!.diagnostic.length).toBeLessThanOrEqual(300);
  });

  it("uses last error event", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("error", 1, 1, "First error", 2000);
    trail.recordEvent("error", 1, 2, "Second error (final)", 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary!.failedStepDescription).toBe("Second error (final)");
    expect(summary!.failedAttempt).toBe(2);
  });
});

// --- suggestion generation --------------------------------------------------

describe("suggested actions", () => {
  it("suggests retry when retries exist", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("retry", 1, 1, "Retrying", 2000);
    trail.recordEvent("error", 1, 2, "Failed again", 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary!.suggestedActions).toContain("retry");
    expect(summary!.suggestedActions).toContain("investigate");
    expect(summary!.suggestedActions).toContain("cancel");
  });

  it("suggests edit-plan when plan steps exist", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("plan-step", 1, 1, "Step 1", 2000);
    trail.recordEvent("error", 1, 1, "Failed", 4000);

    const summary = buildFailureSummary(history, trail);
    expect(summary!.suggestedActions).toContain("edit-plan");
  });

  it("always suggests investigate and cancel", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const summary = buildFailureSummary(history);
    expect(summary!.suggestedActions).toContain("investigate");
    expect(summary!.suggestedActions).toContain("cancel");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatFailureSummary", () => {
  it("renders failure summary with diagnostic and suggestions", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy to production", 1000, "Prod Deploy");
    history.updateStatus("failed", 5000, "agent", "CI failed");

    const trail = new ExecutionAuditTrail();
    trail.recordEvent("error", 1, 1, "Test timeout", 4000);

    const output = formatFailureSummary(buildFailureSummary(history, trail));
    expect(output).toContain("Goal Failure Summary");
    expect(output).toContain("Prod Deploy");
    expect(output).toContain("Test timeout");
    expect(output).toContain("Suggested actions:");
    expect(output).toContain("Investigate");
    expect(output).toContain("Cancel");
  });

  it("renders null for non-failed Goal", () => {
    const output = formatFailureSummary(null);
    expect(output).toContain("No failure to summarize");
  });

  it("is deterministic", () => {
    const history = new GoalRevisionHistory();
    history.setObjective("Deploy", 1000);
    history.updateStatus("failed", 5000);

    const summary = buildFailureSummary(history);
    const a = formatFailureSummary(summary);
    const b = formatFailureSummary(summary);
    expect(a).toBe(b);
  });
});
