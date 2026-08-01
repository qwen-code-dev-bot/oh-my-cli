// Read-only effective-policy inspection: composes policy rules from
// organization, user, repository, and session layers with explicit
// precedence and immutable deny rules.
//
// Policy rules expose id, scope, decision, source layer, and precedence.
// Layer composition follows org > user > repo > session; deny rules are
// immutable and override allow. The view is read-only and never executes
// commands, modifies policy files, or weakens safety.

export const POLICY_INSPECTION_SCHEMA = "oh-my-cli.policy-inspection";
export const POLICY_INSPECTION_VERSION = 1;

// --- types ------------------------------------------------------------------

export type PolicyScope = "tool" | "provider" | "extension" | "network" | "data";
export type PolicyDecision = "allow" | "deny";
export type PolicyLayer = "organization" | "user" | "repository" | "session";

const LAYER_PRECEDENCE: Record<PolicyLayer, number> = {
  organization: 4,
  user: 3,
  repository: 2,
  session: 1,
};

export interface PolicyRule {
  /** Rule identifier. */
  id: string;
  /** What this rule governs. */
  scope: PolicyScope;
  /** The target pattern (e.g. "shell", "network:*", "ext:browser"). */
  target: string;
  decision: PolicyDecision;
  layer: PolicyLayer;
  /** Whether this deny rule is immutable (cannot be overridden). */
  immutable: boolean;
  /** Human-readable reason. */
  reason: string;
}

export interface EffectivePolicy {
  /** The target this policy applies to. */
  target: string;
  scope: PolicyScope;
  /** The effective decision after layer composition. */
  decision: PolicyDecision;
  /** The governing rule that determined the decision. */
  governingRule: PolicyRule;
  /** All rules that apply to this target, ordered by precedence. */
  applicableRules: PolicyRule[];
  /** Explanation of why the decision was made. */
  explanation: string;
}

// --- policy composition -----------------------------------------------------

// Compose effective policy for a target from a set of rules.
// Deny rules are immutable and always win over allow rules.
// Among same-decision rules, higher-precedence layers win.
export function composePolicy(
  target: string,
  scope: PolicyScope,
  rules: PolicyRule[],
): EffectivePolicy {
  // Filter applicable rules (matching target and scope).
  const applicable = rules
    .filter((r) => r.scope === scope && matchesTarget(r.target, target))
    .sort((a, b) => LAYER_PRECEDENCE[b.layer] - LAYER_PRECEDENCE[a.layer]);

  if (applicable.length === 0) {
    // Default: allow with no governing rule.
    const defaultRule: PolicyRule = {
      id: "default",
      scope,
      target: "*",
      decision: "allow",
      layer: "session",
      immutable: false,
      reason: "No policy rules matched; default allow",
    };
    return {
      target,
      scope,
      decision: "allow",
      governingRule: defaultRule,
      applicableRules: [],
      explanation: "No policy rules matched. Default: allow.",
    };
  }

  // Immutable deny rules always win.
  const immutableDeny = applicable.find((r) => r.decision === "deny" && r.immutable);
  if (immutableDeny) {
    return {
      target,
      scope,
      decision: "deny",
      governingRule: immutableDeny,
      applicableRules: applicable,
      explanation: `Denied by immutable rule "${immutableDeny.id}" from ${immutableDeny.layer} layer: ${immutableDeny.reason}`,
    };
  }

  // Highest-precedence rule wins.
  const governing = applicable[0];
  return {
    target,
    scope,
    decision: governing.decision,
    governingRule: governing,
    applicableRules: applicable,
    explanation: `${governing.decision === "allow" ? "Allowed" : "Denied"} by rule "${governing.id}" from ${governing.layer} layer: ${governing.reason}`,
  };
}

function matchesTarget(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1);
    return target.startsWith(prefix);
  }
  return pattern === target;
}

// --- policy inspector -------------------------------------------------------

export class PolicyInspector {
  private readonly rules: PolicyRule[] = [];

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /** Evaluate effective policy for a target. */
  evaluate(target: string, scope: PolicyScope): EffectivePolicy {
    return composePolicy(target, scope, this.rules);
  }

  /** Evaluate all unique targets in the rules. */
  evaluateAll(): EffectivePolicy[] {
    const targets = new Set(this.rules.map((r) => r.target));
    const results: EffectivePolicy[] = [];
    for (const target of targets) {
      const scope = this.rules.find((r) => r.target === target)?.scope ?? "tool";
      results.push(this.evaluate(target, scope));
    }
    return results;
  }

  listRules(): PolicyRule[] {
    return [...this.rules];
  }

  get size(): number {
    return this.rules.length;
  }
}

// --- formatting -------------------------------------------------------------

export function formatEffectivePolicy(policy: EffectivePolicy): string {
  const icon = policy.decision === "allow" ? "✓" : "✗";
  const lines: string[] = [];
  lines.push(`${icon} ${policy.target} [${policy.scope}] → ${policy.decision.toUpperCase()}`);
  lines.push(`  ${policy.explanation}`);

  if (policy.applicableRules.length > 1) {
    lines.push(`  Rules (${policy.applicableRules.length}):`);
    for (const rule of policy.applicableRules) {
      const imm = rule.immutable ? " [IMMUTABLE]" : "";
      const gov = rule.id === policy.governingRule.id ? " ← governing" : "";
      lines.push(`    ${rule.decision} ${rule.id} [${rule.layer}]${imm}${gov}`);
    }
  }

  return lines.join("\n");
}

export function formatInspectorSummary(inspector: PolicyInspector): string {
  const lines: string[] = [];
  lines.push("Policy Inspection");
  lines.push("═".repeat(50));
  lines.push(`Rules: ${inspector.size}`);

  const policies = inspector.evaluateAll();
  const denied = policies.filter((p) => p.decision === "deny");
  const allowed = policies.filter((p) => p.decision === "allow");
  lines.push(`Effective: ${allowed.length} allowed, ${denied.length} denied`);

  for (const policy of policies) {
    lines.push("");
    lines.push(formatEffectivePolicy(policy));
  }

  lines.push("");
  lines.push("Read-only: no commands executed, no policy files modified.");

  return lines.join("\n");
}
