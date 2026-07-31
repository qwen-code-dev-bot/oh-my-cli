// Mission status: surface the actionable state of a mission from the durable
// lifecycle projection (#313) — approval gates that pause execution, retries with
// bounded-retry semantics, budget nodes, and the nodes that are waiting or
// failed. This is the gate/retry/budget surfacing child of the mission-control
// roadmap (Issue #297); the read-only TUI view (#314), intervention controls
// (#316), and the Desktop canvas (#318) present this status rather than
// re-deriving it.
//
// The surfacing distinguishes a WAITING node (a non-terminal blocked state — an
// approval gate or a transient external condition) from a FAILED node (a terminal
// error), consistent with the #308 failure-presentation semantics: waiting is not
// a code failure. Everything surfaced here is read straight from the projection —
// this module never invents a gate, retry, or budget value, and it never animates
// state the durable events did not produce.
//
// Trust boundary: the surfacing is a pure read of the projection. Node labels
// were already sanitized when they entered the projection (#313); this module
// carries them through unchanged and adds no untrusted content.

import type { LifecycleModel, LifecycleNode } from "./lifecycle-projection.js";
import { isTerminal } from "./lifecycle-projection.js";

export const MISSION_STATUS_SCHEMA = "oh-my-cli.mission-status";
export const MISSION_STATUS_VERSION = 1;

// The status categories surfaced from the projection, in presentation order.
export const MISSION_STATUS_CATEGORIES = [
  "gate",
  "retry",
  "budget",
  "waiting",
  "failed",
] as const;
export type MissionStatusCategory = (typeof MISSION_STATUS_CATEGORIES)[number];

// Static description of each surfaced category: what it means and what it draws
// from in the projection. This is fixed product metadata (the surfacing
// contract), exposed via --mission-status; it is NOT a mission's runtime state.
export interface MissionStatusCategoryInfo {
  category: MissionStatusCategory;
  meaning: string;
  source: string;
}

export const MISSION_STATUS_CATEGORY_INFO: readonly MissionStatusCategoryInfo[] = [
  {
    category: "gate",
    meaning: "An approval gate that pauses execution until it is resolved.",
    source: "nodes of kind 'gate'",
  },
  {
    category: "retry",
    meaning: "A bounded retry of a step that failed transiently.",
    source: "nodes of kind 'retry'",
  },
  {
    category: "budget",
    meaning: "A budget the mission consumes (time, cost, or rounds).",
    source: "nodes of kind 'budget'",
  },
  {
    category: "waiting",
    meaning: "A non-terminal blocked state (a gate or a transient external condition); not a code failure.",
    source: "nodes in state 'waiting'",
  },
  {
    category: "failed",
    meaning: "A terminal failure of a node.",
    source: "nodes in state 'failed'",
  },
];

// The surfaced status of one mission, read from its lifecycle projection.
export interface MissionStatus {
  schema: string;
  version: number;
  gates: LifecycleNode[];
  retries: LifecycleNode[];
  budgets: LifecycleNode[];
  waiting: LifecycleNode[];
  failed: LifecycleNode[];
  activeCount: number;
  terminal: boolean;
}

// Surface the actionable status of a mission from its lifecycle projection.
// Pure read: gates/retries/budgets are grouped by node kind; waiting/failed are
// grouped by node state. Waiting (non-terminal blocked) is kept distinct from
// failed (terminal error).
export function collectMissionStatus(model: LifecycleModel): MissionStatus {
  return {
    schema: MISSION_STATUS_SCHEMA,
    version: MISSION_STATUS_VERSION,
    gates: model.nodes.filter((n) => n.kind === "gate"),
    retries: model.nodes.filter((n) => n.kind === "retry"),
    budgets: model.nodes.filter((n) => n.kind === "budget"),
    waiting: model.nodes.filter((n) => n.state === "waiting"),
    failed: model.nodes.filter((n) => n.state === "failed"),
    activeCount: model.nodes.filter((n) => n.state === "active").length,
    terminal: isTerminal(model),
  };
}

// A redacted, human-readable rendering of a mission's surfaced status.
export function formatMissionStatus(status: MissionStatus): string {
  const list = (nodes: LifecycleNode[]): string =>
    nodes.length === 0 ? "(none)" : nodes.map((n) => `${n.label || n.id} [${n.state}]`).join(", ");
  return [
    "Mission Status",
    "─".repeat(40),
    `Schema: ${status.schema} v${status.version}`,
    `Terminal: ${status.terminal}`,
    `Active nodes: ${status.activeCount}`,
    `Gates: ${list(status.gates)}`,
    `Retries: ${list(status.retries)}`,
    `Budgets: ${list(status.budgets)}`,
    `Waiting: ${list(status.waiting)}`,
    `Failed: ${list(status.failed)}`,
  ].join("\n");
}

// The static surfacing contract exposed to users and surfaces: the categories
// surfaced and what each means/draws from. Fixed metadata — no mission state.
export interface MissionStatusDescriptor {
  schema: string;
  version: number;
  categories: MissionStatusCategoryInfo[];
}

// Build the static descriptor. Pure and side-effect-free.
export function collectMissionStatusDescriptor(): MissionStatusDescriptor {
  return {
    schema: MISSION_STATUS_SCHEMA,
    version: MISSION_STATUS_VERSION,
    categories: MISSION_STATUS_CATEGORY_INFO.map((c) => ({ ...c })),
  };
}

// A redacted, human-readable rendering of the static descriptor.
export function formatMissionStatusDescriptor(descriptor: MissionStatusDescriptor): string {
  return [
    "Mission Status Surfacing Contract",
    "─".repeat(40),
    `Schema: ${descriptor.schema} v${descriptor.version}`,
    "",
    "Surfaced categories (category -> meaning; source):",
    ...descriptor.categories.map(
      (c) => `  ${c.category} -> ${c.meaning} (from ${c.source})`,
    ),
  ].join("\n");
}
