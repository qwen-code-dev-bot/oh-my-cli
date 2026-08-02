import { describe, it, expect } from "vitest";
import {
  requestApproval,
  approvePlan,
  rejectPlan,
  editStep,
  formatPlanApproval,
} from "../../src/plan-approval.js";
import { generateOutline } from "../../src/execution-outline.js";

// Pure-function coverage for plan approval (Issue #411): approval request,
// approval/rejection recording, step editing, and determinism.

// --- approval request -------------------------------------------------------

describe("requestApproval", () => {
  it("creates a pending approval from an outline", () => {
    const outline = generateOutline("Build API, write tests, deploy");
    const approval = requestApproval(outline);

    expect(approval.state).toBe("pending");
    expect(approval.objective).toBe("Build API, write tests, deploy");
    expect(approval.stepCount).toBe(3);
    expect(approval.stepDescriptions).toHaveLength(3);
    expect(approval.wasEdited).toBe(false);
    expect(approval.decidedBy).toBeUndefined();
  });
});

// --- approval recording -----------------------------------------------------

describe("approvePlan", () => {
  it("approves a pending plan", () => {
    const outline = generateOutline("Build API, write tests");
    const approval = requestApproval(outline);
    const approved = approvePlan(approval, "user", 5000);

    expect(approved.state).toBe("approved");
    expect(approved.decidedBy).toBe("user");
    expect(approved.decidedAt).toBe(5000);
  });

  it("does not re-approve an already decided plan", () => {
    const outline = generateOutline("Build API, write tests");
    let approval = requestApproval(outline);
    approval = rejectPlan(approval, "Too risky");
    const result = approvePlan(approval);

    expect(result.state).toBe("rejected"); // Unchanged.
  });

  it("approves an edited plan", () => {
    const outline = generateOutline("Build API, write tests");
    let approval = requestApproval(outline);
    approval = editStep(approval, 0, "Build REST API");
    const approved = approvePlan(approval, "user");

    expect(approved.state).toBe("approved");
    expect(approved.wasEdited).toBe(true);
  });
});

// --- rejection recording ----------------------------------------------------

describe("rejectPlan", () => {
  it("rejects a pending plan with reason", () => {
    const outline = generateOutline("Build API, write tests");
    const approval = requestApproval(outline);
    const rejected = rejectPlan(approval, "Too costly", "user", 5000);

    expect(rejected.state).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Too costly");
    expect(rejected.decidedBy).toBe("user");
  });

  it("redacts secrets in rejection reason", () => {
    const outline = generateOutline("Build API");
    const approval = requestApproval(outline);
    const rejected = rejectPlan(approval, "Failed because --token=supersecretvalue123");

    expect(rejected.rejectionReason).toContain("[REDACTED]");
    expect(rejected.rejectionReason).not.toContain("supersecretvalue123");
  });

  it("bounds rejection reason at 200 chars", () => {
    const outline = generateOutline("Build API");
    const approval = requestApproval(outline);
    const rejected = rejectPlan(approval, "x".repeat(500));

    expect(rejected.rejectionReason!.length).toBeLessThanOrEqual(200);
  });
});

// --- step editing -----------------------------------------------------------

describe("editStep", () => {
  it("edits a step description", () => {
    const outline = generateOutline("Build API, write tests");
    const approval = requestApproval(outline);
    const edited = editStep(approval, 0, "Build REST API with auth");

    expect(edited.state).toBe("edited");
    expect(edited.wasEdited).toBe(true);
    expect(edited.stepDescriptions[0]).toBe("Build REST API with auth");
    expect(edited.stepDescriptions[1]).toBe("write tests");
  });

  it("does not edit after decision", () => {
    const outline = generateOutline("Build API, write tests");
    let approval = requestApproval(outline);
    approval = approvePlan(approval);
    const result = editStep(approval, 0, "Changed");

    expect(result.stepDescriptions[0]).toBe("Build API"); // Unchanged.
  });

  it("ignores invalid step index", () => {
    const outline = generateOutline("Build API");
    const approval = requestApproval(outline);
    const result = editStep(approval, 99, "Invalid");

    expect(result.stepDescriptions).toEqual(approval.stepDescriptions);
  });

  it("redacts secrets in edited description", () => {
    const outline = generateOutline("Build API");
    const approval = requestApproval(outline);
    const edited = editStep(approval, 0, "Deploy with --token=supersecretvalue123");

    expect(edited.stepDescriptions[0]).toContain("[REDACTED]");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatPlanApproval", () => {
  it("renders pending approval with steps", () => {
    const outline = generateOutline("Build API, write tests, deploy");
    const approval = requestApproval(outline);
    const output = formatPlanApproval(approval);

    expect(output).toContain("PENDING");
    expect(output).toContain("Build API");
    expect(output).toContain("1. Build API");
    expect(output).toContain("2. write tests");
    expect(output).toContain("3. deploy");
  });

  it("renders approved approval with decision", () => {
    const outline = generateOutline("Build API, write tests");
    let approval = requestApproval(outline);
    approval = approvePlan(approval, "user");
    const output = formatPlanApproval(approval);

    expect(output).toContain("APPROVED");
    expect(output).toContain("Decision: approved by user");
  });

  it("renders rejected approval with reason", () => {
    const outline = generateOutline("Build API");
    let approval = requestApproval(outline);
    approval = rejectPlan(approval, "Too risky");
    const output = formatPlanApproval(approval);

    expect(output).toContain("REJECTED");
    expect(output).toContain("Reason: Too risky");
  });

  it("shows edited marker", () => {
    const outline = generateOutline("Build API, write tests");
    let approval = requestApproval(outline);
    approval = editStep(approval, 0, "Build REST API");
    const output = formatPlanApproval(approval);

    expect(output).toContain("EDITED");
    expect(output).toContain("(edited)");
  });

  it("is deterministic", () => {
    const outline = generateOutline("Build API, write tests");
    const approval = requestApproval(outline);
    const a = formatPlanApproval(approval);
    const b = formatPlanApproval(approval);
    expect(a).toBe(b);
  });
});
