import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_PROJECTION_SCHEMA,
  LIFECYCLE_PROJECTION_VERSION,
  NODE_KINDS,
  NODE_STATES,
  LIFECYCLE_EVENT_TYPES,
  emptyLifecycleModel,
  reduceEvent,
  replayEvents,
  nodeById,
  activeNodes,
  waitingNodes,
  isTerminal,
  collectLifecycleModel,
  formatLifecycleModel,
} from "../../src/lifecycle-projection.js";
import type { LifecycleEvent, NodeKind } from "../../src/lifecycle-projection.js";

describe("lifecycle projection constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(LIFECYCLE_PROJECTION_SCHEMA).toBe("oh-my-cli.lifecycle-projection");
    expect(LIFECYCLE_PROJECTION_VERSION).toBe(1);
  });

  it("pins the canonical node kinds, states, and event types", () => {
    expect(NODE_KINDS).toEqual(["goal", "phase", "gate", "retry", "budget", "outcome"]);
    expect(NODE_STATES).toEqual(["pending", "active", "waiting", "succeeded", "failed", "skipped"]);
    expect(LIFECYCLE_EVENT_TYPES).toEqual(["node-added", "node-transition", "edge-added"]);
  });
});

describe("reduceEvent: node-added", () => {
  it("adds a node in the pending state and advances the revision", () => {
    const model = reduceEvent(emptyLifecycleModel(), {
      type: "node-added",
      id: "g1",
      kind: "goal",
      label: "Ship it",
    });
    expect(model.nodes).toEqual([{ id: "g1", kind: "goal", state: "pending", label: "Ship it" }]);
    expect(model.revision).toBe(1);
  });

  it("defaults the label to the node id when absent", () => {
    const model = reduceEvent(emptyLifecycleModel(), { type: "node-added", id: "p1", kind: "phase" });
    expect(model.nodes[0].label).toBe("p1");
  });

  it("never adds a duplicate node id (no revision advance)", () => {
    const once = reduceEvent(emptyLifecycleModel(), { type: "node-added", id: "g1", kind: "goal" });
    const twice = reduceEvent(once, { type: "node-added", id: "g1", kind: "phase" });
    expect(twice.nodes.length).toBe(1);
    expect(twice.nodes[0].kind).toBe("goal");
    expect(twice.revision).toBe(1);
  });

  it("ignores an invalid node kind", () => {
    const model = reduceEvent(emptyLifecycleModel(), {
      type: "node-added",
      id: "x",
      kind: "bogus" as NodeKind,
    });
    expect(model.nodes.length).toBe(0);
    expect(model.revision).toBe(0);
  });
});

describe("reduceEvent: nodes appear only from node-added", () => {
  it("a transition targeting a missing node creates nothing", () => {
    const model = reduceEvent(emptyLifecycleModel(), {
      type: "node-transition",
      id: "ghost",
      to: "active",
    });
    expect(model.nodes.length).toBe(0);
    expect(model.revision).toBe(0);
  });

  it("an edge targeting a missing node creates nothing", () => {
    const withOne = reduceEvent(emptyLifecycleModel(), { type: "node-added", id: "a", kind: "phase" });
    const model = reduceEvent(withOne, { type: "edge-added", from: "a", to: "missing" });
    expect(model.edges.length).toBe(0);
    expect(model.revision).toBe(1);
  });
});

describe("reduceEvent: node-transition", () => {
  it("transitions an existing node and advances the revision", () => {
    let model = reduceEvent(emptyLifecycleModel(), { type: "node-added", id: "g1", kind: "goal" });
    model = reduceEvent(model, { type: "node-transition", id: "g1", to: "active" });
    expect(nodeById(model, "g1")!.state).toBe("active");
    expect(model.revision).toBe(2);
  });

  it("ignores a transition to an invalid state and a no-op transition", () => {
    let model = reduceEvent(emptyLifecycleModel(), { type: "node-added", id: "g1", kind: "goal" });
    model = reduceEvent(model, { type: "node-transition", id: "g1", to: "bogus" as never });
    expect(model.revision).toBe(1);
    model = reduceEvent(model, { type: "node-transition", id: "g1", to: "pending" });
    expect(model.revision).toBe(1); // already pending -> no-op
  });
});

describe("reduceEvent: edge-added", () => {
  it("links two existing nodes, rejects duplicates and self-edges", () => {
    let model = replayEvents([
      { type: "node-added", id: "a", kind: "phase" },
      { type: "node-added", id: "b", kind: "phase" },
    ]);
    model = reduceEvent(model, { type: "edge-added", from: "b", to: "a" });
    expect(model.edges).toEqual([{ from: "b", to: "a" }]);
    const dup = reduceEvent(model, { type: "edge-added", from: "b", to: "a" });
    expect(dup.edges.length).toBe(1);
    const self = reduceEvent(model, { type: "edge-added", from: "a", to: "a" });
    expect(self.edges.length).toBe(1);
  });
});

describe("replayEvents: determinism and structure", () => {
  const log: LifecycleEvent[] = [
    { type: "node-added", id: "goal", kind: "goal", label: "Mission" },
    { type: "node-added", id: "p1", kind: "phase" },
    { type: "node-added", id: "p2", kind: "phase" },
    { type: "edge-added", from: "p2", to: "p1" },
    { type: "node-transition", id: "goal", to: "active" },
    { type: "node-transition", id: "p1", to: "active" },
    { type: "node-transition", id: "p2", to: "active" },
    { type: "node-added", id: "gate", kind: "gate" },
    { type: "node-transition", id: "gate", to: "waiting" },
    { type: "node-added", id: "out", kind: "outcome" },
    { type: "node-transition", id: "out", to: "succeeded" },
  ];

  it("is deterministic: the same log yields an equal model", () => {
    expect(replayEvents(log)).toEqual(replayEvents(log));
  });

  it("represents dependencies, parallel lanes, gates, and terminal outcomes", () => {
    const model = replayEvents(log);
    expect(model.edges).toEqual([{ from: "p2", to: "p1" }]);
    // p1 and p2 are both active -> two parallel lanes.
    expect(activeNodes(model).map((n) => n.id).sort()).toEqual(["goal", "p1", "p2"]);
    expect(waitingNodes(model).map((n) => n.id)).toEqual(["gate"]);
    expect(nodeById(model, "out")!.state).toBe("succeeded");
  });
});

describe("queries: isTerminal", () => {
  it("is false for an empty or partially-active model", () => {
    expect(isTerminal(emptyLifecycleModel())).toBe(false);
    const partial = replayEvents([
      { type: "node-added", id: "a", kind: "phase" },
      { type: "node-transition", id: "a", to: "active" },
    ]);
    expect(isTerminal(partial)).toBe(false);
  });

  it("is true when every node reached a terminal state", () => {
    const done = replayEvents([
      { type: "node-added", id: "a", kind: "phase" },
      { type: "node-added", id: "b", kind: "phase" },
      { type: "node-transition", id: "a", to: "succeeded" },
      { type: "node-transition", id: "b", to: "skipped" },
    ]);
    expect(isTerminal(done)).toBe(true);
  });
});

describe("label sanitization", () => {
  it("redacts secrets and neutralizes escapes in node labels", () => {
    const model = reduceEvent(emptyLifecycleModel(), {
      type: "node-added",
      id: "g1",
      kind: "goal",
      label: "auth sk-abcdefghijklmnopqrst \u001b[31mred",
    });
    expect(model.nodes[0].label).not.toContain("sk-abcdefghijklmnopqrst");
    expect(model.nodes[0].label).toContain("[REDACTED]");
    expect(model.nodes[0].label).not.toContain("\u001b");
  });
});

describe("collectLifecycleModel / formatLifecycleModel", () => {
  it("collects the canonical descriptor", () => {
    const descriptor = collectLifecycleModel();
    expect(descriptor.schema).toBe(LIFECYCLE_PROJECTION_SCHEMA);
    expect(descriptor.nodeKinds).toEqual([...NODE_KINDS]);
    expect(descriptor.nodeStates).toEqual([...NODE_STATES]);
    expect(descriptor.eventTypes).toEqual([...LIFECYCLE_EVENT_TYPES]);
    expect(descriptor.terminalStates).toEqual(["succeeded", "failed", "skipped"]);
  });

  it("renders the descriptor", () => {
    const out = formatLifecycleModel(collectLifecycleModel());
    expect(out).toContain(LIFECYCLE_PROJECTION_SCHEMA);
    expect(out).toContain("Node kinds: goal · phase · gate · retry · budget · outcome");
    expect(out).toContain("Terminal states: succeeded · failed · skipped");
    expect(out).toContain("Event types: node-added · node-transition · edge-added");
  });
});
