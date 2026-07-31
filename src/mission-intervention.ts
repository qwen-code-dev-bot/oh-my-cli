// Mission intervention: safe operations on a running mission — inspect, pause,
// resume, approve, reject, cancel, and open receipts. This is the
// intervention-controls child of the mission-control roadmap (Issue #297); the
// TUI view (#314) and Desktop canvas (#318) expose these controls and the
// evidence-bound capstone (#319) relies on them.
//
// The core safety rule: every MUTATION-bearing intervention (pause, resume,
// approve, reject, cancel) first validates that the caller owns the session and
// that the head has not moved. An intervention against an unowned session or a
// moved head is refused with the contract's canonical delivery-state failure
// semantic (from #300) — never a surface-local message — and produces no event.
// Read-only interventions (inspect, open-receipt) need no ownership check. When
// allowed, a mutation is recorded as a durable #313 lifecycle event (a
// node-transition) so the projection — not this module — remains the source of
// truth and the intervention is replayable on reconnect (#317).
//
// Trust boundary: planning an intervention is pure and executes nothing; it only
// decides whether an intervention is allowed and, if so, what durable event
// records it. No secrets are involved and no state is mutated here.

import { conceptById } from "./concept-contract.js";
import type { LifecycleEvent, NodeState } from "./lifecycle-projection.js";

export const MISSION_INTERVENTION_SCHEMA = "oh-my-cli.mission-intervention";
export const MISSION_INTERVENTION_VERSION = 1;

// The intervention kinds, in presentation order.
export const INTERVENTION_KINDS = [
  "inspect",
  "pause",
  "resume",
  "approve",
  "reject",
  "cancel",
  "open-receipt",
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

// Static description of each intervention: whether it mutates, the lifecycle
// state it transitions the target node to (null for read-only interventions),
// and a human description. Fixed product metadata (the intervention contract),
// exposed via --intervention-model.
export interface InterventionInfo {
  kind: InterventionKind;
  mutates: boolean;
  targetState: NodeState | null;
  description: string;
}

export const INTERVENTION_INFO: readonly InterventionInfo[] = [
  { kind: "inspect", mutates: false, targetState: null, description: "Inspect a node's state and detail (read-only)." },
  { kind: "pause", mutates: true, targetState: "waiting", description: "Pause an active node (moves it to waiting)." },
  { kind: "resume", mutates: true, targetState: "active", description: "Resume a paused node (moves it to active)." },
  { kind: "approve", mutates: true, targetState: "succeeded", description: "Approve a gate (moves it to succeeded)." },
  { kind: "reject", mutates: true, targetState: "failed", description: "Reject a gate (moves it to failed)." },
  { kind: "cancel", mutates: true, targetState: "skipped", description: "Cancel a node (moves it to skipped)." },
  { kind: "open-receipt", mutates: false, targetState: null, description: "Open a node's durable receipt (read-only)." },
];

// Look up the static info for an intervention kind.
export function interventionInfo(kind: InterventionKind): InterventionInfo | null {
  return INTERVENTION_INFO.find((info) => info.kind === kind) ?? null;
}

// The canonical failure semantic used to refuse an unsafe mutation: the
// delivery-state semantic from the #300 concept contract.
function canonicalRefusalSemantic(): string {
  return conceptById("delivery-state").failureSemantic;
}

// Ownership context for a mutation-bearing intervention: the actual session
// owner and head versus the expected owner and the head the session is bound to.
export interface InterventionOwnership {
  sessionOwner: string;
  expectedOwner: string;
  currentHead: string;
  boundHead: string;
}

// The result of planning an intervention: whether it is allowed, why, and (for an
// allowed mutation) the durable lifecycle event that records it.
export interface InterventionPlan {
  kind: InterventionKind;
  allowed: boolean;
  reason: string;
  event: LifecycleEvent | null;
}

// Plan an intervention against a target node. Pure and side-effect-free.
// - An unknown kind is refused.
// - A read-only intervention (inspect, open-receipt) is allowed with no event and
//   no ownership check.
// - A mutation-bearing intervention validates ownership (session owner matches
//   and the head has not moved); if valid it returns the durable node-transition
//   event that records it; otherwise it is refused with the canonical semantic.
export function planIntervention(
  kind: InterventionKind,
  targetNodeId: string,
  ownership: InterventionOwnership,
): InterventionPlan {
  const info = interventionInfo(kind);
  if (!info) {
    return { kind, allowed: false, reason: "unknown intervention kind", event: null };
  }
  if (!info.mutates) {
    return { kind, allowed: true, reason: "read-only intervention", event: null };
  }
  if (ownership.sessionOwner !== ownership.expectedOwner) {
    return {
      kind,
      allowed: false,
      reason: `${canonicalRefusalSemantic()} (session not owned by ${ownership.expectedOwner})`,
      event: null,
    };
  }
  if (ownership.currentHead !== ownership.boundHead) {
    return {
      kind,
      allowed: false,
      reason: `${canonicalRefusalSemantic()} (head moved from ${ownership.boundHead.slice(0, 12)} to ${ownership.currentHead.slice(0, 12)})`,
      event: null,
    };
  }
  // targetState is non-null for every mutating kind by construction.
  const event: LifecycleEvent = {
    type: "node-transition",
    id: targetNodeId,
    to: info.targetState as NodeState,
  };
  return { kind, allowed: true, reason: "ownership validated", event };
}

// The static intervention contract exposed to users and surfaces: the kinds,
// whether each mutates, and the lifecycle state each maps to. Fixed metadata.
export interface InterventionDescriptor {
  schema: string;
  version: number;
  interventions: InterventionInfo[];
}

// Build the static descriptor. Pure and side-effect-free.
export function collectInterventionDescriptor(): InterventionDescriptor {
  return {
    schema: MISSION_INTERVENTION_SCHEMA,
    version: MISSION_INTERVENTION_VERSION,
    interventions: INTERVENTION_INFO.map((info) => ({ ...info })),
  };
}

// A redacted, human-readable rendering of the static descriptor.
export function formatInterventionDescriptor(descriptor: InterventionDescriptor): string {
  return [
    "Mission Intervention Contract",
    "─".repeat(40),
    `Schema: ${descriptor.schema} v${descriptor.version}`,
    "",
    "Interventions (kind [mutates -> target state]: description):",
    ...descriptor.interventions.map(
      (info) =>
        `  ${info.kind} [${info.mutates ? `mutates -> ${info.targetState}` : "read-only"}]: ${info.description}`,
    ),
  ].join("\n");
}
