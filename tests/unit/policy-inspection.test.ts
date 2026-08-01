import { describe, it, expect } from "vitest";
import {
  PolicyInspector,
  composePolicy,
  formatEffectivePolicy,
  formatInspectorSummary,
  type PolicyRule,
} from "../../src/policy-inspection.js";

// Pure-function coverage for policy inspection (Issue #379): precedence,
// immutable deny, multi-layer, conflict resolution, explainer, and
// read-only guarantee.

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "r1", scope: "tool", target: "shell", decision: "allow",
    layer: "user", immutable: false, reason: "User allows shell",
    ...overrides,
  };
}

// --- precedence -------------------------------------------------------------

describe("precedence", () => {
  it("higher-precedence layer wins", () => {
    const rules = [
      rule({ id: "org-deny", decision: "deny", layer: "organization", reason: "Org denies shell" }),
      rule({ id: "user-allow", decision: "allow", layer: "user", reason: "User allows shell" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    expect(policy.decision).toBe("deny");
    expect(policy.governingRule.id).toBe("org-deny");
    expect(policy.explanation).toContain("organization");
  });

  it("same layer uses first rule", () => {
    const rules = [
      rule({ id: "r1", decision: "allow", layer: "user" }),
      rule({ id: "r2", decision: "deny", layer: "user" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    // Both same precedence; sorted stably, first wins.
    expect(policy.governingRule.layer).toBe("user");
  });

  it("defaults to allow when no rules match", () => {
    const policy = composePolicy("unknown-tool", "tool", []);
    expect(policy.decision).toBe("allow");
    expect(policy.governingRule.id).toBe("default");
  });
});

// --- immutable deny ---------------------------------------------------------

describe("immutable deny", () => {
  it("immutable deny overrides all allows", () => {
    const rules = [
      rule({ id: "session-allow", decision: "allow", layer: "session" }),
      rule({ id: "user-allow", decision: "allow", layer: "user" }),
      rule({ id: "org-immutable-deny", decision: "deny", layer: "organization", immutable: true, reason: "Security: no network" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    expect(policy.decision).toBe("deny");
    expect(policy.governingRule.id).toBe("org-immutable-deny");
    expect(policy.explanation).toContain("immutable");
  });

  it("non-immutable deny can be overridden by higher layer allow", () => {
    const rules = [
      rule({ id: "repo-deny", decision: "deny", layer: "repository", immutable: false }),
      rule({ id: "org-allow", decision: "allow", layer: "organization", immutable: false }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    expect(policy.decision).toBe("allow");
    expect(policy.governingRule.id).toBe("org-allow");
  });
});

// --- target matching --------------------------------------------------------

describe("target matching", () => {
  it("matches wildcard patterns", () => {
    const rules = [
      rule({ id: "deny-net", target: "network:*", scope: "network", decision: "deny", layer: "organization", reason: "No network" }),
    ];

    const policy = composePolicy("network:api.example.com", "network", rules);
    expect(policy.decision).toBe("deny");
  });

  it("matches exact targets", () => {
    const rules = [
      rule({ id: "allow-shell", target: "shell", decision: "allow", layer: "user" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    expect(policy.decision).toBe("allow");

    const noMatch = composePolicy("editor", "tool", rules);
    expect(noMatch.decision).toBe("allow");
    expect(noMatch.governingRule.id).toBe("default");
  });

  it("matches global wildcard", () => {
    const rules = [
      rule({ id: "deny-all", target: "*", decision: "deny", layer: "organization", reason: "Lockdown" }),
    ];

    const policy = composePolicy("anything", "tool", rules);
    expect(policy.decision).toBe("deny");
  });
});

// --- multi-layer fixture ----------------------------------------------------

describe("multi-layer fixture", () => {
  it("composes policies across all four layers", () => {
    const inspector = new PolicyInspector();
    inspector.addRule(rule({ id: "org-net-deny", scope: "network", target: "network:*", decision: "deny", layer: "organization", immutable: true, reason: "Air-gapped" }));
    inspector.addRule(rule({ id: "user-shell-allow", scope: "tool", target: "shell", decision: "allow", layer: "user", reason: "Trusted user" }));
    inspector.addRule(rule({ id: "repo-ext-deny", scope: "extension", target: "ext:untrusted", decision: "deny", layer: "repository", reason: "Untrusted extension" }));
    inspector.addRule(rule({ id: "session-data-allow", scope: "data", target: "data:public", decision: "allow", layer: "session", reason: "Public data" }));

    expect(inspector.size).toBe(4);

    const netPolicy = inspector.evaluate("network:api.example.com", "network");
    expect(netPolicy.decision).toBe("deny");

    const shellPolicy = inspector.evaluate("shell", "tool");
    expect(shellPolicy.decision).toBe("allow");

    const extPolicy = inspector.evaluate("ext:untrusted", "extension");
    expect(extPolicy.decision).toBe("deny");
  });
});

// --- conflict resolution fixture --------------------------------------------

describe("conflict resolution", () => {
  it("resolves allow/deny conflict with precedence", () => {
    const rules = [
      rule({ id: "session-allow", decision: "allow", layer: "session", reason: "Session needs shell" }),
      rule({ id: "org-deny", decision: "deny", layer: "organization", reason: "Org policy: no shell" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    expect(policy.decision).toBe("deny");
    expect(policy.governingRule.id).toBe("org-deny");
    expect(policy.applicableRules).toHaveLength(2);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatting", () => {
  it("renders effective policy with explanation", () => {
    const rules = [
      rule({ id: "org-deny", decision: "deny", layer: "organization", immutable: true, reason: "Security lockdown" }),
      rule({ id: "user-allow", decision: "allow", layer: "user", reason: "User wants shell" }),
    ];

    const policy = composePolicy("shell", "tool", rules);
    const output = formatEffectivePolicy(policy);

    expect(output).toContain("DENY");
    expect(output).toContain("immutable");
    expect(output).toContain("org-deny");
    expect(output).toContain("governing");
  });

  it("renders inspector summary", () => {
    const inspector = new PolicyInspector();
    inspector.addRule(rule({ id: "r1", decision: "allow", layer: "user" }));

    const output = formatInspectorSummary(inspector);
    expect(output).toContain("Policy Inspection");
    expect(output).toContain("Rules: 1");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("evaluation does not modify rules", () => {
    const inspector = new PolicyInspector();
    inspector.addRule(rule({ id: "r1" }));

    const before = inspector.size;
    inspector.evaluate("shell", "tool");
    expect(inspector.size).toBe(before);
  });
});
