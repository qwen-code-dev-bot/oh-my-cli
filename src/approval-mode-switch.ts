// Runtime approval-mode switching (Issue #715): the pure decision model behind
// the interactive `/approval-mode` command. The palette used to advertise three
// multi-word stubs that could never resolve from typed input and changed
// nothing from palette selection; this model makes the advertised control real
// and honest: report the effective mode, reject invalid input naming the valid
// modes, apply a de-escalation (tighter gating) immediately, and apply an
// escalation (looser gating) only through an explicit two-step confirmation.
//
// The decision is pure and shared by both interactive surfaces so the
// full-screen shell and the plain readline REPL render identical outcomes. The
// approval plane itself (needsApproval/promptApproval) is untouched — it
// consumes the effective mode as input.

import type { ApprovalMode } from "./approval.js";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["default", "auto-edit", "yolo"];

// Permission rank: lower is stricter. De-escalation moves toward 0,
// escalation away from it.
const MODE_RANK: Record<ApprovalMode, number> = {
  default: 0,
  "auto-edit": 1,
  yolo: 2,
};

export function parseApprovalMode(text: string): ApprovalMode | null {
  const trimmed = text.trim().toLowerCase();
  const match = APPROVAL_MODES.find((mode) => mode.toLowerCase() === trimmed);
  return match ?? null;
}

export type ApprovalModeCommandDecision =
  // No argument: report the effective mode and the command shape.
  | { kind: "report"; mode: ApprovalMode }
  // Unknown mode or trailing form: nothing changes; the notice names the
  // valid modes / usage.
  | { kind: "invalid"; requested: string }
  // Requested mode equals the effective one: nothing changes, said plainly.
  | { kind: "unchanged"; mode: ApprovalMode }
  // Strictly tighter gating: applies immediately.
  | { kind: "de-escalate"; mode: ApprovalMode }
  // Looser gating: NOT applied. The caller records the pending escalation and
  // shows the warning; only the explicit confirm form applies it.
  | { kind: "escalation-needs-confirm"; mode: ApprovalMode }
  // `confirm` was given but there is no matching pending escalation: nothing
  // changes, and the notice says exactly that.
  | { kind: "escalation-unconfirmed"; mode: ApprovalMode }
  // `confirm` matches the pending escalation: applies.
  | { kind: "escalation-confirmed"; mode: ApprovalMode };

export function approvalModeCommandDecision(
  current: ApprovalMode,
  args: string,
  pendingEscalation: ApprovalMode | null,
): ApprovalModeCommandDecision {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "report", mode: current };
  const mode = parseApprovalMode(parts[0]);
  if (mode === null) return { kind: "invalid", requested: parts[0] };
  const rest = parts.slice(1);
  if (rest.length > 0 && rest.join(" ").toLowerCase() !== "confirm") {
    return { kind: "invalid", requested: rest.join(" ") };
  }
  const confirmed = rest.length > 0;
  if (mode === current) return { kind: "unchanged", mode };
  if (MODE_RANK[mode] < MODE_RANK[current]) return { kind: "de-escalate", mode };
  // Escalation from here on: never applied without the explicit confirm form
  // matching a pending request for exactly this mode.
  if (!confirmed) return { kind: "escalation-needs-confirm", mode };
  if (pendingEscalation !== mode) return { kind: "escalation-unconfirmed", mode };
  return { kind: "escalation-confirmed", mode };
}

// Does the decision apply a new effective mode?
export function decisionAppliesMode(
  decision: ApprovalModeCommandDecision,
): decision is
  | { kind: "de-escalate"; mode: ApprovalMode }
  | { kind: "escalation-confirmed"; mode: ApprovalMode } {
  return decision.kind === "de-escalate" || decision.kind === "escalation-confirmed";
}

// What pending escalation the caller should hold after this decision: an
// escalation request replaces it; every other outcome clears it, so a stale
// confirmation can never apply a request the user moved away from.
export function nextPendingEscalation(
  decision: ApprovalModeCommandDecision,
): ApprovalMode | null {
  return decision.kind === "escalation-needs-confirm" ? decision.mode : null;
}

const ESCALATION_CONSEQUENCE: Record<ApprovalMode, string> = {
  default: "",
  "auto-edit": "file edits will run without approval; shell commands still require it",
  yolo: "all mutating tools will run without approval",
};

// One shared renderer so both interactive surfaces (and the tests) show the
// same honest outcome. Never implies approval for any pending request.
export function formatApprovalModeNotice(decision: ApprovalModeCommandDecision): string {
  switch (decision.kind) {
    case "report":
      return (
        `Approval mode: ${decision.mode}. ` +
        `Change with /approval-mode <${APPROVAL_MODES.join("|")}>; loosening requires an explicit confirm.`
      );
    case "invalid":
      return (
        `Unknown approval mode or form "${decision.requested}". ` +
        `Valid modes: ${APPROVAL_MODES.join(", ")}. Usage: /approval-mode [mode [confirm]].`
      );
    case "unchanged":
      return `Approval mode is already ${decision.mode}.`;
    case "de-escalate":
      return `Approval mode set to ${decision.mode} (tighter). Subsequent turns are gated by it.`;
    case "escalation-needs-confirm":
      return (
        `Escalating to ${decision.mode} loosens tool gating: ${ESCALATION_CONSEQUENCE[decision.mode]}. ` +
        `Not applied — run /approval-mode ${decision.mode} confirm to apply.`
      );
    case "escalation-unconfirmed":
      return (
        `Nothing confirmed — there is no pending escalation to ${decision.mode}. ` +
        `Run /approval-mode ${decision.mode} first, then /approval-mode ${decision.mode} confirm.`
      );
    case "escalation-confirmed":
      return `Approval mode set to ${decision.mode} (looser, explicitly confirmed). Subsequent turns are gated by it.`;
  }
}
