// Durable lifecycle projection: reduce durable Goal/Workflow runtime events into
// one authoritative lifecycle model — a graph of nodes (goal, phase, gate,
// retry, budget, outcome) and dependency edges with canonical states. This is the
// dependency-first foundation of the mission-control roadmap (Issue #297); the
// read-only TUI view (#314), gate/retry/budget surfacing (#315), intervention
// controls (#316), reconnect reconstruction (#317), Desktop canvas (#318), and
// evidence-bound capstone (#319) all read this projection rather than maintaining
// their own state.
//
// The single invariant the projection enforces: a node APPEARS only from a
// node-added event and TRANSITIONS only from a node-transition event that targets
// an existing node. A transition or edge never creates a node, so no visualization
// built on this model can show a node that durable events did not produce — visual
// progress never outruns runtime truth. The reducer is pure and deterministic:
// replaying the same durable event log always yields the same model, which is what
// lets reconnect (#317) reconstruct the view without rewriting history.
//
// Trust boundary: node labels are untrusted (they may originate from goal
// objectives or workflow definitions); they are secret-redacted and
// escape-neutralized before entering the model. The projection itself carries no
// secrets and never executes anything.

import { redactSecrets } from "./permission-impact.js";
import { neutralizeEscapes } from "./event-presentation.js";

export const LIFECYCLE_PROJECTION_SCHEMA = "oh-my-cli.lifecycle-projection";
export const LIFECYCLE_PROJECTION_VERSION = 1;

// Canonical node kinds, in presentation order. A mission is a graph of these.
export const NODE_KINDS = [
  "goal",
  "phase",
  "gate",
  "retry",
  "budget",
  "outcome",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

// Canonical node states. Terminal states are "succeeded", "failed", and
// "skipped"; "waiting" is a non-terminal blocked state (an approval gate or a
// transient external condition), consistent with the #308 failure semantics.
export const NODE_STATES = [
  "pending",
  "active",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

// The durable event types that drive the projection. Nothing else can change the
// model.
export const LIFECYCLE_EVENT_TYPES = [
  "node-added",
  "node-transition",
  "edge-added",
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

// One node in the lifecycle graph.
export interface LifecycleNode {
  id: string;
  kind: NodeKind;
  state: NodeState;
  label: string;
}

// A dependency edge between two existing nodes (from depends-on to).
export interface LifecycleEdge {
  from: string;
  to: string;
}

// The projected lifecycle: an ordered node list, a dependency-edge list, and a
// revision counter that advances once per applied event.
export interface LifecycleModel {
  schema: string;
  version: number;
  revision: number;
  nodes: LifecycleNode[];
  edges: LifecycleEdge[];
}

// A durable runtime event. node-added introduces a node (initial state pending);
// node-transition moves an existing node to a new state; edge-added links two
// existing nodes.
export type LifecycleEvent =
  | { type: "node-added"; id: string; kind: NodeKind; label?: string }
  | { type: "node-transition"; id: string; to: NodeState }
  | { type: "edge-added"; from: string; to: string };

function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

function isNodeState(value: unknown): value is NodeState {
  return typeof value === "string" && (NODE_STATES as readonly string[]).includes(value);
}

// Sanitize an untrusted node label: redact secrets and neutralize escape
// sequences so a label can never smuggle credentials or terminal control codes
// into a rendered mission view.
function sanitizeLabel(label: string): string {
  return neutralizeEscapes(redactSecrets(label).text);
}

// The empty lifecycle model (revision 0, no nodes, no edges).
export function emptyLifecycleModel(): LifecycleModel {
  return {
    schema: LIFECYCLE_PROJECTION_SCHEMA,
    version: LIFECYCLE_PROJECTION_VERSION,
    revision: 0,
    nodes: [],
    edges: [],
  };
}

// Pure reducer: fold one durable event into a new lifecycle model. The reducer is
// total and side-effect-free; an event that does not apply (unknown type, invalid
// kind/state, transition or edge targeting a missing node, duplicate node/edge)
// leaves the model unchanged and does NOT advance the revision. A node appears
// only from node-added and transitions only via node-transition on an existing
// node.
export function reduceEvent(model: LifecycleModel, event: LifecycleEvent): LifecycleModel {
  switch (event.type) {
    case "node-added": {
      if (!isNodeKind(event.kind)) return model;
      if (event.id === "" || model.nodes.some((n) => n.id === event.id)) return model;
      const node: LifecycleNode = {
        id: event.id,
        kind: event.kind,
        state: "pending",
        label: sanitizeLabel(event.label ?? event.id),
      };
      return { ...model, revision: model.revision + 1, nodes: [...model.nodes, node] };
    }
    case "node-transition": {
      if (!isNodeState(event.to)) return model;
      const index = model.nodes.findIndex((n) => n.id === event.id);
      if (index === -1) return model; // a transition never creates a node
      const current = model.nodes[index];
      if (current.state === event.to) return model; // no-op transition
      const updated: LifecycleNode = { ...current, state: event.to };
      const nodes = model.nodes.slice();
      nodes[index] = updated;
      return { ...model, revision: model.revision + 1, nodes };
    }
    case "edge-added": {
      const fromExists = model.nodes.some((n) => n.id === event.from);
      const toExists = model.nodes.some((n) => n.id === event.to);
      if (!fromExists || !toExists) return model; // edges link existing nodes only
      if (event.from === event.to) return model;
      if (model.edges.some((e) => e.from === event.from && e.to === event.to)) return model;
      return {
        ...model,
        revision: model.revision + 1,
        edges: [...model.edges, { from: event.from, to: event.to }],
      };
    }
    default:
      return model;
  }
}

// Replay a durable event log from the empty model. Deterministic: the same log
// always yields the same model.
export function replayEvents(events: readonly LifecycleEvent[]): LifecycleModel {
  return events.reduce(reduceEvent, emptyLifecycleModel());
}

// Look up a node by id.
export function nodeById(model: LifecycleModel, id: string): LifecycleNode | null {
  return model.nodes.find((n) => n.id === id) ?? null;
}

// The nodes currently active — the mission's parallel lanes.
export function activeNodes(model: LifecycleModel): LifecycleNode[] {
  return model.nodes.filter((n) => n.state === "active");
}

// The nodes waiting on a gate or transient condition.
export function waitingNodes(model: LifecycleModel): LifecycleNode[] {
  return model.nodes.filter((n) => n.state === "waiting");
}

// True when every node has reached a terminal state (succeeded/failed/skipped)
// and there is at least one node — i.e. the mission has fully resolved.
export function isTerminal(model: LifecycleModel): boolean {
  if (model.nodes.length === 0) return false;
  return model.nodes.every(
    (n) => n.state === "succeeded" || n.state === "failed" || n.state === "skipped",
  );
}

// The canonical model descriptor exposed to users and surfaces: the node kinds,
// node states, and event types the projection understands.
export interface LifecycleModelDescriptor {
  schema: string;
  version: number;
  nodeKinds: NodeKind[];
  nodeStates: NodeState[];
  eventTypes: LifecycleEventType[];
  terminalStates: NodeState[];
}

// Build the canonical descriptor. Pure and side-effect-free.
export function collectLifecycleModel(): LifecycleModelDescriptor {
  return {
    schema: LIFECYCLE_PROJECTION_SCHEMA,
    version: LIFECYCLE_PROJECTION_VERSION,
    nodeKinds: [...NODE_KINDS],
    nodeStates: [...NODE_STATES],
    eventTypes: [...LIFECYCLE_EVENT_TYPES],
    terminalStates: ["succeeded", "failed", "skipped"],
  };
}

// A redacted, human-readable rendering of the canonical descriptor.
export function formatLifecycleModel(descriptor: LifecycleModelDescriptor): string {
  return [
    "Lifecycle Projection Model",
    "─".repeat(40),
    `Schema: ${descriptor.schema} v${descriptor.version}`,
    `Node kinds: ${descriptor.nodeKinds.join(" · ")}`,
    `Node states: ${descriptor.nodeStates.join(" · ")}`,
    `Terminal states: ${descriptor.terminalStates.join(" · ")}`,
    `Event types: ${descriptor.eventTypes.join(" · ")}`,
  ].join("\n");
}
