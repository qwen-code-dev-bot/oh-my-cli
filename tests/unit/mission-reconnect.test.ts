import { describe, it, expect } from "vitest";
import {
  MISSION_RECONNECT_SCHEMA,
  MISSION_RECONNECT_VERSION,
  RECONNECT_GUARANTEES,
  reconnect,
  reconnectIncremental,
  splitReconnectIsConsistent,
  collectReconnectDescriptor,
  formatReconnectDescriptor,
} from "../../src/mission-reconnect.js";
import { replayEvents, emptyLifecycleModel } from "../../src/lifecycle-projection.js";
import type { LifecycleEvent } from "../../src/lifecycle-projection.js";

const durableLog: LifecycleEvent[] = [
  { type: "node-added", id: "goal", kind: "goal", label: "Mission" },
  { type: "node-added", id: "p1", kind: "phase", label: "Build" },
  { type: "node-added", id: "p2", kind: "phase", label: "Deploy" },
  { type: "edge-added", from: "p2", to: "p1" },
  { type: "node-transition", id: "goal", to: "active" },
  { type: "node-transition", id: "p1", to: "active" },
  { type: "node-added", id: "gate", kind: "gate", label: "Approve" },
  { type: "node-transition", id: "gate", to: "waiting" },
  { type: "node-transition", id: "p1", to: "succeeded" },
];

describe("mission reconnect constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(MISSION_RECONNECT_SCHEMA).toBe("oh-my-cli.mission-reconnect");
    expect(MISSION_RECONNECT_VERSION).toBe(1);
  });

  it("pins the guarantees", () => {
    expect(RECONNECT_GUARANTEES).toEqual([
      "deterministic-replay",
      "no-history-rewrite",
      "incremental-continuation",
    ]);
  });
});

describe("reconnect: reconstruction from durable state", () => {
  it("reconstructs the same model as a continuous replay of the log", () => {
    const result = reconnect(durableLog);
    expect(result.eventsReplayed).toBe(durableLog.length);
    expect(result.model).toEqual(replayEvents(durableLog));
  });

  it("reconstructs the empty model from an empty log", () => {
    const result = reconnect([]);
    expect(result.eventsReplayed).toBe(0);
    expect(result.model).toEqual(emptyLifecycleModel());
  });
});

describe("guarantee: deterministic-replay", () => {
  it("two reconnects of the same log agree exactly", () => {
    expect(reconnect(durableLog).model).toEqual(reconnect(durableLog).model);
  });
});

describe("guarantee: no-history-rewrite + incremental-continuation", () => {
  it("splitting the log at any point and replaying prefix-then-suffix equals a full replay", () => {
    for (let split = 0; split <= durableLog.length; split++) {
      expect(splitReconnectIsConsistent(durableLog, split)).toBe(true);
    }
  });

  it("reconnectIncremental from a checkpoint equals a full replay", () => {
    const prefix = durableLog.slice(0, 5);
    const suffix = durableLog.slice(5);
    const checkpoint = replayEvents(prefix);
    const continued = reconnectIncremental(checkpoint, suffix);
    expect(continued).toEqual(replayEvents(durableLog));
  });

  it("clamps an out-of-range split safely", () => {
    expect(splitReconnectIsConsistent(durableLog, -3)).toBe(true);
    expect(splitReconnectIsConsistent(durableLog, 999)).toBe(true);
  });
});

describe("collectReconnectDescriptor / formatReconnectDescriptor", () => {
  it("collects the static reconnect contract", () => {
    const descriptor = collectReconnectDescriptor();
    expect(descriptor.schema).toBe(MISSION_RECONNECT_SCHEMA);
    expect(descriptor.guarantees).toEqual([...RECONNECT_GUARANTEES]);
    expect(descriptor.replayedEventTypes).toEqual([
      "node-added",
      "node-transition",
      "edge-added",
    ]);
  });

  it("renders the contract", () => {
    const out = formatReconnectDescriptor(collectReconnectDescriptor());
    expect(out).toContain(MISSION_RECONNECT_SCHEMA);
    expect(out).toContain("deterministic-replay");
    expect(out).toContain("no-history-rewrite");
    expect(out).toContain("incremental-continuation");
    expect(out).toContain("Replayed event types: node-added · node-transition · edge-added");
  });
});
