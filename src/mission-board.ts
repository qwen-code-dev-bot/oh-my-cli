// Read-only mission board: inspects sessions, agents, leases, worktrees,
// objectives, branches, heads, budgets, dependencies, and terminal states
// from one shared model.
//
// The mission board is a strictly read-only inventory. It never acquires a
// lease, switches a branch, resumes an agent, or mutates a worktree. Stale
// or contradictory ownership fails closed with visible reasons rather than
// being normalized away. The model is surface-independent: the same inventory
// produces the same output for the TUI and a future Desktop pane.

export const MISSION_BOARD_SCHEMA = "oh-my-cli.mission-board";
export const MISSION_BOARD_VERSION = 1;

// --- entry types ------------------------------------------------------------

export type SessionStatus = "active" | "idle" | "completed" | "failed" | "cancelled";
export type AgentStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type LeaseStatus = "held" | "released" | "stale" | "conflict";
export type ObjectiveStatus = "active" | "completed" | "blocked" | "failed";

export interface SessionEntry {
  id: string;
  name: string;
  status: SessionStatus;
  workspace: string;
  /** Epoch ms of creation. */
  createdAt: number;
  /** Epoch ms of last activity. */
  lastActivityAt: number;
}

export interface AgentEntry {
  id: string;
  sessionId: string;
  status: AgentStatus;
  /** Workspace path the agent operates in (when mutating). */
  workspace?: string;
  /** Lease ID held by this agent (at most one). */
  leaseId?: string;
}

export interface LeaseEntry {
  id: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  owner: string;
  status: LeaseStatus;
  /** Epoch ms of acquisition. */
  acquiredAt: number;
}

export interface ObjectiveEntry {
  id: string;
  title: string;
  status: ObjectiveStatus;
  /** Issue numbers this objective depends on. */
  dependencies: number[];
  /** Issue numbers that are satisfied (closed). */
  satisfiedDependencies: number[];
}

// --- ownership conflicts ----------------------------------------------------

export type ConflictReason =
  | "multiple-leases-per-agent"
  | "multiple-agents-per-lease"
  | "stale-lease"
  | "orphaned-lease"
  | "workspace-overlap";

export interface OwnershipConflict {
  reason: ConflictReason;
  /** IDs of the entities involved. */
  entities: string[];
  detail: string;
}

// --- mission board ----------------------------------------------------------

export interface MissionBoard {
  schema: typeof MISSION_BOARD_SCHEMA;
  v: typeof MISSION_BOARD_VERSION;
  sessions: SessionEntry[];
  agents: AgentEntry[];
  leases: LeaseEntry[];
  objectives: ObjectiveEntry[];
  /** Ownership contradictions detected during assembly. */
  conflicts: OwnershipConflict[];
  /** True when any conflict was detected. */
  hasConflicts: boolean;
  /** Snapshot time (epoch ms). */
  snapshotAt: number;
}

// --- assembly ---------------------------------------------------------------

export interface MissionInventory {
  sessions: SessionEntry[];
  agents: AgentEntry[];
  leases: LeaseEntry[];
  objectives: ObjectiveEntry[];
}

// Assemble a read-only mission board from raw inventory data. Validates
// ownership invariants and surfaces contradictions as conflicts rather
// than normalizing them away.
export function assembleMissionBoard(inventory: MissionInventory): MissionBoard {
  const conflicts: OwnershipConflict[] = [];

  // Invariant: each agent holds at most one lease.
  const agentLeases = new Map<string, string[]>();
  for (const agent of inventory.agents) {
    if (agent.leaseId) {
      const existing = agentLeases.get(agent.id) ?? [];
      existing.push(agent.leaseId);
      agentLeases.set(agent.id, existing);
    }
  }
  for (const [agentId, leaseIds] of agentLeases) {
    if (leaseIds.length > 1) {
      conflicts.push({
        reason: "multiple-leases-per-agent",
        entities: [agentId, ...leaseIds],
        detail: `Agent ${agentId} holds ${leaseIds.length} leases: ${leaseIds.join(", ")}`,
      });
    }
  }

  // Invariant: each lease is held by at most one agent.
  const leaseAgents = new Map<string, string[]>();
  for (const agent of inventory.agents) {
    if (agent.leaseId) {
      const existing = leaseAgents.get(agent.leaseId) ?? [];
      existing.push(agent.id);
      leaseAgents.set(agent.leaseId, existing);
    }
  }
  for (const [leaseId, agentIds] of leaseAgents) {
    if (agentIds.length > 1) {
      conflicts.push({
        reason: "multiple-agents-per-lease",
        entities: [leaseId, ...agentIds],
        detail: `Lease ${leaseId} is claimed by ${agentIds.length} agents: ${agentIds.join(", ")}`,
      });
    }
  }

  // Invariant: no stale leases (held but owner is not an active agent).
  const activeAgentIds = new Set(
    inventory.agents.filter((a) => a.status === "running" || a.status === "paused").map((a) => a.id),
  );
  for (const lease of inventory.leases) {
    if (lease.status === "held" && !activeAgentIds.has(lease.owner)) {
      conflicts.push({
        reason: "stale-lease",
        entities: [lease.id, lease.owner],
        detail: `Lease ${lease.id} is held by ${lease.owner} who is not an active agent`,
      });
    }
  }

  // Invariant: no orphaned leases (referenced by an agent but not in the lease list).
  const leaseIds = new Set(inventory.leases.map((l) => l.id));
  for (const agent of inventory.agents) {
    if (agent.leaseId && !leaseIds.has(agent.leaseId)) {
      conflicts.push({
        reason: "orphaned-lease",
        entities: [agent.id, agent.leaseId],
        detail: `Agent ${agent.id} references lease ${agent.leaseId} which does not exist`,
      });
    }
  }

  // Invariant: no workspace overlap between mutating agents.
  const workspaceAgents = new Map<string, string[]>();
  for (const agent of inventory.agents) {
    if (agent.workspace && (agent.status === "running" || agent.status === "paused")) {
      const existing = workspaceAgents.get(agent.workspace) ?? [];
      existing.push(agent.id);
      workspaceAgents.set(agent.workspace, existing);
    }
  }
  for (const [workspace, agentIds] of workspaceAgents) {
    if (agentIds.length > 1) {
      conflicts.push({
        reason: "workspace-overlap",
        entities: [workspace, ...agentIds],
        detail: `Workspace ${workspace} has ${agentIds.length} mutating agents: ${agentIds.join(", ")}`,
      });
    }
  }

  return {
    schema: MISSION_BOARD_SCHEMA,
    v: MISSION_BOARD_VERSION,
    sessions: inventory.sessions,
    agents: inventory.agents,
    leases: inventory.leases,
    objectives: inventory.objectives,
    conflicts,
    hasConflicts: conflicts.length > 0,
    snapshotAt: Date.now(),
  };
}

// --- objective helpers ------------------------------------------------------

// Whether an objective's dependencies are all satisfied.
export function isObjectiveReady(obj: ObjectiveEntry): boolean {
  return obj.dependencies.every((d) => obj.satisfiedDependencies.includes(d));
}

// The unsatisfied dependencies of an objective.
export function unsatisfiedDependencies(obj: ObjectiveEntry): number[] {
  return obj.dependencies.filter((d) => !obj.satisfiedDependencies.includes(d));
}

// --- formatting -------------------------------------------------------------

// Format a mission board as a compact, color-independent TUI tree/table.
export function formatMissionBoard(board: MissionBoard): string {
  const lines: string[] = [];
  lines.push("Mission Board");
  lines.push("═".repeat(50));

  // Sessions.
  lines.push("");
  lines.push(`Sessions (${board.sessions.length}):`);
  for (const s of board.sessions) {
    const icon = sessionIcon(s.status);
    lines.push(`  ${icon} ${s.name} [${s.status}] ws:${s.workspace}`);
  }

  // Agents.
  lines.push("");
  lines.push(`Agents (${board.agents.length}):`);
  for (const a of board.agents) {
    const icon = agentIcon(a.status);
    const lease = a.leaseId ? ` lease:${a.leaseId}` : "";
    const ws = a.workspace ? ` ws:${a.workspace}` : "";
    lines.push(`  ${icon} ${a.id} [${a.status}] session:${a.sessionId}${lease}${ws}`);
  }

  // Leases.
  lines.push("");
  lines.push(`Leases (${board.leases.length}):`);
  for (const l of board.leases) {
    const icon = leaseIcon(l.status);
    lines.push(`  ${icon} #${l.issueNumber} [${l.status}] branch:${l.branch} owner:${l.owner}`);
  }

  // Objectives.
  lines.push("");
  lines.push(`Objectives (${board.objectives.length}):`);
  for (const o of board.objectives) {
    const icon = objectiveIcon(o.status);
    const deps = o.dependencies.length > 0
      ? ` deps:[${o.dependencies.join(",")}]`
      : "";
    const ready = isObjectiveReady(o) ? " ✓ready" : ` blocked:[${unsatisfiedDependencies(o).join(",")}]`;
    lines.push(`  ${icon} ${o.title} [${o.status}]${deps}${ready}`);
  }

  // Conflicts.
  if (board.hasConflicts) {
    lines.push("");
    lines.push(`⚠ CONFLICTS (${board.conflicts.length}):`);
    for (const c of board.conflicts) {
      lines.push(`  ✗ [${c.reason}] ${c.detail}`);
    }
  } else {
    lines.push("");
    lines.push("Conflicts: none");
  }

  return lines.join("\n");
}

function sessionIcon(status: SessionStatus): string {
  switch (status) {
    case "active": return "●";
    case "idle": return "○";
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
  }
}

function agentIcon(status: AgentStatus): string {
  switch (status) {
    case "running": return "▶";
    case "paused": return "‖";
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled": return "⊘";
  }
}

function leaseIcon(status: LeaseStatus): string {
  switch (status) {
    case "held": return "🔒";
    case "released": return "🔓";
    case "stale": return "⚠";
    case "conflict": return "✗";
  }
}

function objectiveIcon(status: ObjectiveStatus): string {
  switch (status) {
    case "active": return "◆";
    case "completed": return "✓";
    case "blocked": return "⊘";
    case "failed": return "✗";
  }
}
