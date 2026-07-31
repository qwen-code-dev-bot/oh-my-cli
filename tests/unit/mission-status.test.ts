import { describe, it, expect } from "vitest";
import {
  MISSION_STATUS_SCHEMA,
  MISSION_STATUS_VERSION,
  MISSION_STATUS_CATEGORIES,
  MISSION_STATUS_CATEGORY_INFO,
  collectMissionStatus,
  formatMissionStatus,
  collectMissionStatusDescriptor,
  formatMissionStatusDescriptor,
} from "../../src/mission-status.js";
import { replayEvents, emptyLifecycleModel } from "../../src/lifecycle-projection.js";
import type { LifecycleEvent } from "../../src/lifecycle-projection.js";

// Build a representative mission: a goal, two phases, an approval gate that is
// waiting, a retry, a budget, and a failed phase.
const missionLog: LifecycleEvent[] = [
  { type: "node-added", id: "goal", kind: "goal", label: "Mission" },
  { type: "node-added", id: "p1", kind: "phase", label: "Build" },
  { type: "node-added", id: "p2", kind: "phase", label: "Deploy" },
  { type: "node-added", id: "gate1", kind: "gate", label: "Approve deploy" },
  { type: "node-added", id: "retry1", kind: "retry", label: "Retry flaky test" },
  { type: "node-added", id: "budget1", kind: "budget", label: "Cost budget" },
  { type: "node-transition", id: "goal", to: "active" },
  { type: "node-transition", id: "p1", to: "succeeded" },
  { type: "node-transition", id: "p2", to: "failed" },
  { type: "node-transition", id: "gate1", to: "waiting" },
  { type: "node-transition", id: "retry1", to: "active" },
  { type: "node-transition", id: "budget1", to: "active" },
];

describe("mission status constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(MISSION_STATUS_SCHEMA).toBe("oh-my-cli.mission-status");
    expect(MISSION_STATUS_VERSION).toBe(1);
  });

  it("pins the surfaced categories", () => {
    expect(MISSION_STATUS_CATEGORIES).toEqual(["gate", "retry", "budget", "waiting", "failed"]);
    expect(MISSION_STATUS_CATEGORY_INFO.map((c) => c.category)).toEqual([
      "gate",
      "retry",
      "budget",
      "waiting",
      "failed",
    ]);
    for (const info of MISSION_STATUS_CATEGORY_INFO) {
      expect(info.meaning.length).toBeGreaterThan(0);
      expect(info.source.length).toBeGreaterThan(0);
    }
  });
});

describe("collectMissionStatus: surfacing from the projection", () => {
  it("surfaces gates, retries, and budgets by node kind", () => {
    const status = collectMissionStatus(replayEvents(missionLog));
    expect(status.gates.map((n) => n.id)).toEqual(["gate1"]);
    expect(status.retries.map((n) => n.id)).toEqual(["retry1"]);
    expect(status.budgets.map((n) => n.id)).toEqual(["budget1"]);
  });

  it("surfaces waiting and failed nodes by state, kept distinct", () => {
    const status = collectMissionStatus(replayEvents(missionLog));
    // The gate is waiting (non-terminal blocked), not failed.
    expect(status.waiting.map((n) => n.id)).toEqual(["gate1"]);
    // p2 failed (terminal error), distinct from waiting.
    expect(status.failed.map((n) => n.id)).toEqual(["p2"]);
    // No node appears in both waiting and failed.
    const waitingIds = new Set(status.waiting.map((n) => n.id));
    for (const f of status.failed) expect(waitingIds.has(f.id)).toBe(false);
  });

  it("reports active count and terminal flag", () => {
    const status = collectMissionStatus(replayEvents(missionLog));
    // goal, retry1, budget1 are active.
    expect(status.activeCount).toBe(3);
    expect(status.terminal).toBe(false);
  });

  it("reports a terminal mission when every node is terminal", () => {
    const done = replayEvents([
      { type: "node-added", id: "g", kind: "goal" },
      { type: "node-transition", id: "g", to: "succeeded" },
    ]);
    const status = collectMissionStatus(done);
    expect(status.terminal).toBe(true);
    expect(status.activeCount).toBe(0);
  });

  it("surfaces nothing for an empty projection", () => {
    const status = collectMissionStatus(emptyLifecycleModel());
    expect(status.gates).toEqual([]);
    expect(status.retries).toEqual([]);
    expect(status.budgets).toEqual([]);
    expect(status.waiting).toEqual([]);
    expect(status.failed).toEqual([]);
    expect(status.activeCount).toBe(0);
    expect(status.terminal).toBe(false);
  });
});

describe("formatMissionStatus", () => {
  it("renders the surfaced status with labels and states", () => {
    const out = formatMissionStatus(collectMissionStatus(replayEvents(missionLog)));
    expect(out).toContain(MISSION_STATUS_SCHEMA);
    expect(out).toContain("Gates: Approve deploy [waiting]");
    expect(out).toContain("Retries: Retry flaky test [active]");
    expect(out).toContain("Budgets: Cost budget [active]");
    expect(out).toContain("Waiting: Approve deploy [waiting]");
    expect(out).toContain("Failed: Deploy [failed]");
    expect(out).toContain("Active nodes: 3");
  });

  it("renders (none) for empty categories", () => {
    const out = formatMissionStatus(collectMissionStatus(emptyLifecycleModel()));
    expect(out).toContain("Gates: (none)");
    expect(out).toContain("Failed: (none)");
  });
});

describe("collectMissionStatusDescriptor / formatMissionStatusDescriptor", () => {
  it("collects the static surfacing contract", () => {
    const descriptor = collectMissionStatusDescriptor();
    expect(descriptor.schema).toBe(MISSION_STATUS_SCHEMA);
    expect(descriptor.categories.map((c) => c.category)).toEqual([...MISSION_STATUS_CATEGORIES]);
  });

  it("renders the contract with meanings and sources", () => {
    const out = formatMissionStatusDescriptor(collectMissionStatusDescriptor());
    expect(out).toContain(MISSION_STATUS_SCHEMA);
    expect(out).toContain("gate ->");
    expect(out).toContain("waiting ->");
    expect(out).toContain("from nodes of kind 'gate'");
    expect(out).toContain("from nodes in state 'waiting'");
  });
});
