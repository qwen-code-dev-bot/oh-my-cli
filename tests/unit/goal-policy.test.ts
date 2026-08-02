import { describe, it, expect } from "vitest";
import {
  deriveGoalExecutionPolicy,
  formatGoalExecutionPolicy,
  GOAL_POLICY_SCHEMA,
  GOAL_POLICY_VERSION,
} from "../../src/goal-policy.js";
import type { GoalExecutionPolicyInput } from "../../src/goal-policy.js";

// Behavior-sensitive coverage for Goal execution policy derivation (Issue
// #456): approval mapping, folder-trust subordination of approval modes,
// immutable deny carry-through, fail-closed gate precedence, derivation
// ordering, and determinism.

const BASE: GoalExecutionPolicyInput = {
  approvalMode: "default",
  folderTrustEnforced: false,
  folderTrusted: true,
  sandboxActive: false,
  deniedTargets: [],
  budgetStopped: false,
  revisionStale: false,
};

// --- approval mapping -------------------------------------------------------

describe("approval mode mapping", () => {
  it("default mode requires approval for both mutating categories", () => {
    const policy = deriveGoalExecutionPolicy(BASE);
    expect(policy.approvalRequired.read).toBe(false);
    expect(policy.approvalRequired["mutate-file"]).toBe(true);
    expect(policy.approvalRequired["mutate-shell"]).toBe(true);
  });

  it("auto-edit mode auto-approves file edits but not shell", () => {
    const policy = deriveGoalExecutionPolicy({ ...BASE, approvalMode: "auto-edit" });
    expect(policy.approvalRequired["mutate-file"]).toBe(false);
    expect(policy.approvalRequired["mutate-shell"]).toBe(true);
  });

  it("yolo mode requires no approvals", () => {
    const policy = deriveGoalExecutionPolicy({ ...BASE, approvalMode: "yolo" });
    expect(policy.approvalRequired.read).toBe(false);
    expect(policy.approvalRequired["mutate-file"]).toBe(false);
    expect(policy.approvalRequired["mutate-shell"]).toBe(false);
  });
});

// --- folder-trust gate ------------------------------------------------------

describe("folder-trust gate", () => {
  it("enforced trust with an untrusted workspace denies mutating tools and gates read-only", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      folderTrustEnforced: true,
      folderTrusted: false,
    });
    expect(policy.mutatingToolsAllowed).toBe(false);
    expect(policy.gate).toBe("read-only");
    expect(policy.gateReason).toContain("fail closed");
  });

  it("yolo does not widen an enforced untrusted workspace", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      approvalMode: "yolo",
      folderTrustEnforced: true,
      folderTrusted: false,
    });
    expect(policy.mutatingToolsAllowed).toBe(false);
    expect(policy.gate).toBe("read-only");
  });

  it("enforced trust with a trusted workspace allows mutating tools", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      folderTrustEnforced: true,
      folderTrusted: true,
    });
    expect(policy.mutatingToolsAllowed).toBe(true);
    expect(policy.gate).toBe("run");
  });

  it("untrusted without enforcement does not deny mutating tools", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      folderTrustEnforced: false,
      folderTrusted: false,
    });
    expect(policy.mutatingToolsAllowed).toBe(true);
    expect(policy.gate).toBe("run");
  });
});

// --- immutable deny carry-through -------------------------------------------

describe("immutable deny carry-through", () => {
  it("carries deny targets through regardless of approval mode", () => {
    for (const mode of ["default", "auto-edit", "yolo"] as const) {
      const policy = deriveGoalExecutionPolicy({
        ...BASE,
        approvalMode: mode,
        deniedTargets: ["shell", "network:*"],
      });
      expect(policy.deniedTargets).toEqual(["network:*", "shell"]);
      expect(policy.derivation.some((s) => s.includes("immutable"))).toBe(true);
    }
  });

  it("deduplicates and sorts deny targets deterministically", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      deniedTargets: ["shell", "shell", "ext:browser"],
    });
    expect(policy.deniedTargets).toEqual(["ext:browser", "shell"]);
  });
});

// --- gate precedence --------------------------------------------------------

describe("gate precedence (fail closed)", () => {
  it("stops on a reached budget", () => {
    const policy = deriveGoalExecutionPolicy({ ...BASE, budgetStopped: true });
    expect(policy.gate).toBe("stopped-budget");
    expect(policy.gateReason).toContain("budget");
  });

  it("stops on a stale revision", () => {
    const policy = deriveGoalExecutionPolicy({ ...BASE, revisionStale: true });
    expect(policy.gate).toBe("stopped-stale-revision");
    expect(policy.gateReason).toContain("stale");
  });

  it("stale revision takes precedence over a reached budget", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      revisionStale: true,
      budgetStopped: true,
    });
    expect(policy.gate).toBe("stopped-stale-revision");
  });

  it("budget stop takes precedence over the read-only gate", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      budgetStopped: true,
      folderTrustEnforced: true,
      folderTrusted: false,
    });
    expect(policy.gate).toBe("stopped-budget");
    // The folder-trust denial is still recorded even while budget-stopped.
    expect(policy.mutatingToolsAllowed).toBe(false);
  });

  it("runs when every gate is satisfied", () => {
    const policy = deriveGoalExecutionPolicy(BASE);
    expect(policy.gate).toBe("run");
    expect(policy.gateReason).toContain("all gates satisfied");
  });
});

// --- derivation -------------------------------------------------------------

describe("derivation", () => {
  it("records ordered steps for every applied rule", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      folderTrustEnforced: true,
      folderTrusted: true,
      sandboxActive: true,
      deniedTargets: ["shell"],
    });
    expect(policy.derivation.length).toBe(5);
    expect(policy.derivation[0]).toContain("approval mode default");
    expect(policy.derivation[1]).toContain("folder trust");
    expect(policy.derivation[2]).toContain("sandbox: active");
    expect(policy.derivation[3]).toContain("shell");
    expect(policy.derivation[4]).toContain("gate: run");
  });

  it("omits the deny step when no deny targets exist", () => {
    const policy = deriveGoalExecutionPolicy(BASE);
    expect(policy.derivation.length).toBe(4);
    expect(policy.derivation.some((s) => s.includes("immutable"))).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const input: GoalExecutionPolicyInput = {
      ...BASE,
      approvalMode: "auto-edit",
      folderTrustEnforced: true,
      folderTrusted: false,
      sandboxActive: true,
      deniedTargets: ["network:*", "shell"],
      budgetStopped: true,
    };
    const a = deriveGoalExecutionPolicy(input);
    const b = deriveGoalExecutionPolicy(input);
    expect(a).toEqual(b);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatGoalExecutionPolicy", () => {
  it("renders the full posture", () => {
    const policy = deriveGoalExecutionPolicy({
      ...BASE,
      folderTrustEnforced: true,
      folderTrusted: false,
      deniedTargets: ["shell"],
    });
    const output = formatGoalExecutionPolicy(policy);
    expect(output).toContain(GOAL_POLICY_SCHEMA);
    expect(output).toContain(`v${GOAL_POLICY_VERSION}`);
    expect(output).toContain("Approval mode: default");
    expect(output).toContain("Mutating tools: DENIED (folder trust)");
    expect(output).toContain("Denied targets: shell");
    expect(output).toContain("Gate: read-only");
    expect(output).toContain("Derivation:");
    expect(output).toContain("1.");
  });

  it("renders allowed posture with no denied targets", () => {
    const output = formatGoalExecutionPolicy(deriveGoalExecutionPolicy(BASE));
    expect(output).toContain("Mutating tools: allowed");
    expect(output).toContain("Denied targets: (none)");
    expect(output).toContain("Gate: run");
  });

  it("is deterministic", () => {
    const policy = deriveGoalExecutionPolicy({ ...BASE, budgetStopped: true });
    expect(formatGoalExecutionPolicy(policy)).toBe(formatGoalExecutionPolicy(policy));
  });
});
