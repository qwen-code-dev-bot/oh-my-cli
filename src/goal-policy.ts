// Goal execution policy derivation: composes the existing approval, folder
// trust, sandbox, and policy-deny surfaces into the effective execution
// posture of a Goal attempt.
//
// Goal execution must inherit the ordinary gates rather than bypass them.
// The derivation is pure and read-only: it never mutates policy files,
// approval state, or Goal state, and it never widens permissions — approval
// modes stay subordinate to folder trust, and immutable deny targets stay
// denied. Gates fail closed.

import type { ApprovalMode, ToolCategory } from "./approval.js";
import { needsApproval } from "./approval.js";

export const GOAL_POLICY_SCHEMA = "oh-my-cli.goal-policy";
export const GOAL_POLICY_VERSION = 1;

// --- types ------------------------------------------------------------------

export type GoalExecutionGate =
  | "run"
  | "read-only"
  | "stopped-budget"
  | "stopped-stale-revision";

export interface GoalExecutionPolicyInput {
  /** The active approval mode. */
  approvalMode: ApprovalMode;
  /** Whether folder-trust enforcement is on for this run. */
  folderTrustEnforced: boolean;
  /** Whether the workspace is trusted. */
  folderTrusted: boolean;
  /** Whether sandbox confinement is active. */
  sandboxActive: boolean;
  /** Targets of immutable deny rules from the policy layers. */
  deniedTargets: string[];
  /** Whether a Goal budget limit was reached. */
  budgetStopped: boolean;
  /** Whether the active Goal revision is stale. */
  revisionStale: boolean;
}

export interface GoalExecutionPolicy {
  schema: typeof GOAL_POLICY_SCHEMA;
  v: typeof GOAL_POLICY_VERSION;
  approvalMode: ApprovalMode;
  /** Which tool categories still require approval under the mode. */
  approvalRequired: Record<ToolCategory, boolean>;
  /** Whether mutating tools may run at all (folder-trust gate). */
  mutatingToolsAllowed: boolean;
  sandboxActive: boolean;
  /** Immutable deny targets, denied regardless of approval mode. */
  deniedTargets: string[];
  /** The effective execution gate, fail-closed. */
  gate: GoalExecutionGate;
  gateReason: string;
  /** Ordered, human-readable derivation steps. */
  derivation: string[];
}

// --- derivation -------------------------------------------------------------

const TOOL_CATEGORIES: ToolCategory[] = ["read", "mutate-file", "mutate-shell"];

// Derive the effective Goal execution policy. Gate precedence, fail-closed:
// stopped-stale-revision > stopped-budget > read-only (untrusted workspace
// under enforcement) > run. Approval modes never widen folder-trust or deny
// outcomes.
export function deriveGoalExecutionPolicy(
  input: GoalExecutionPolicyInput,
): GoalExecutionPolicy {
  const derivation: string[] = [];

  // 1. Approval mode maps to per-category approval requirements.
  const approvalRequired = Object.fromEntries(
    TOOL_CATEGORIES.map((category) => [category, needsApproval(input.approvalMode, category)]),
  ) as Record<ToolCategory, boolean>;
  derivation.push(
    `approval mode ${input.approvalMode}: ` +
      TOOL_CATEGORIES.map((c) => `${c}=${approvalRequired[c] ? "approval" : "auto"}`).join(", "),
  );

  // 2. Folder-trust gate. Enforcement with an untrusted workspace denies
  // mutating tools regardless of approval mode (yolo cannot widen it).
  const untrustedEnforced = input.folderTrustEnforced && !input.folderTrusted;
  const mutatingToolsAllowed = !untrustedEnforced;
  derivation.push(
    untrustedEnforced
      ? "folder trust: enforced and workspace untrusted → mutating tools denied (fail closed; approval modes stay subordinate)"
      : input.folderTrustEnforced
        ? "folder trust: enforced and workspace trusted → mutating tools allowed"
        : "folder trust: not enforced → mutating tools allowed",
  );

  // 3. Sandbox posture is carried through.
  derivation.push(
    input.sandboxActive
      ? "sandbox: active → confined execution"
      : "sandbox: inactive",
  );

  // 4. Immutable deny targets stay denied regardless of approval mode.
  const deniedTargets = [...new Set(input.deniedTargets)].sort();
  if (deniedTargets.length > 0) {
    derivation.push(
      `policy deny (immutable): ${deniedTargets.join(", ")} denied regardless of approval mode`,
    );
  }

  // 5. Execution gate, fail-closed precedence.
  let gate: GoalExecutionGate;
  let gateReason: string;
  if (input.revisionStale) {
    gate = "stopped-stale-revision";
    gateReason = "the active Goal revision is stale; refusing to execute against an outdated revision";
  } else if (input.budgetStopped) {
    gate = "stopped-budget";
    gateReason = "a Goal budget limit was reached; execution stopped";
  } else if (untrustedEnforced) {
    gate = "read-only";
    gateReason = "folder trust is enforced and the workspace is untrusted; mutating tools denied (fail closed)";
  } else {
    gate = "run";
    gateReason = "all gates satisfied";
  }
  derivation.push(`gate: ${gate} — ${gateReason}`);

  return {
    schema: GOAL_POLICY_SCHEMA,
    v: GOAL_POLICY_VERSION,
    approvalMode: input.approvalMode,
    approvalRequired,
    mutatingToolsAllowed,
    sandboxActive: input.sandboxActive,
    deniedTargets,
    gate,
    gateReason,
    derivation,
  };
}

// --- formatting -------------------------------------------------------------

export function formatGoalExecutionPolicy(policy: GoalExecutionPolicy): string {
  const lines: string[] = [];
  lines.push(`Goal execution policy (${policy.schema} v${policy.v})`);
  lines.push(`Approval mode: ${policy.approvalMode}`);
  lines.push(
    `Approval required: ${TOOL_CATEGORIES.map(
      (c) => `${c}=${policy.approvalRequired[c] ? "yes" : "no"}`,
    ).join(" ")}`,
  );
  lines.push(`Mutating tools: ${policy.mutatingToolsAllowed ? "allowed" : "DENIED (folder trust)"}`);
  lines.push(`Sandbox: ${policy.sandboxActive ? "active" : "inactive"}`);
  lines.push(`Denied targets: ${policy.deniedTargets.length > 0 ? policy.deniedTargets.join(", ") : "(none)"}`);
  lines.push(`Gate: ${policy.gate} — ${policy.gateReason}`);
  lines.push("Derivation:");
  policy.derivation.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step}`);
  });
  return lines.join("\n");
}
