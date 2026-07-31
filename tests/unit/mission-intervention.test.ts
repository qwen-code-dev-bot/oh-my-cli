import { describe, it, expect } from "vitest";
import {
  MISSION_INTERVENTION_SCHEMA,
  MISSION_INTERVENTION_VERSION,
  INTERVENTION_KINDS,
  INTERVENTION_INFO,
  interventionInfo,
  planIntervention,
  collectInterventionDescriptor,
  formatInterventionDescriptor,
} from "../../src/mission-intervention.js";
import type { InterventionOwnership } from "../../src/mission-intervention.js";
import { conceptById } from "../../src/concept-contract.js";
import { replayEvents, reduceEvent, nodeById } from "../../src/lifecycle-projection.js";

const HEAD = "a".repeat(40);

function ownership(overrides: Partial<InterventionOwnership> = {}): InterventionOwnership {
  return {
    sessionOwner: "qwen-code-dev-bot",
    expectedOwner: "qwen-code-dev-bot",
    currentHead: HEAD,
    boundHead: HEAD,
    ...overrides,
  };
}

describe("mission intervention constants (drift guard)", () => {
  it("exposes a stable schema id and version", () => {
    expect(MISSION_INTERVENTION_SCHEMA).toBe("oh-my-cli.mission-intervention");
    expect(MISSION_INTERVENTION_VERSION).toBe(1);
  });

  it("pins the intervention kinds and their mutate/target mapping", () => {
    expect(INTERVENTION_KINDS).toEqual([
      "inspect",
      "pause",
      "resume",
      "approve",
      "reject",
      "cancel",
      "open-receipt",
    ]);
    expect(interventionInfo("inspect")).toMatchObject({ mutates: false, targetState: null });
    expect(interventionInfo("open-receipt")).toMatchObject({ mutates: false, targetState: null });
    expect(interventionInfo("pause")).toMatchObject({ mutates: true, targetState: "waiting" });
    expect(interventionInfo("resume")).toMatchObject({ mutates: true, targetState: "active" });
    expect(interventionInfo("approve")).toMatchObject({ mutates: true, targetState: "succeeded" });
    expect(interventionInfo("reject")).toMatchObject({ mutates: true, targetState: "failed" });
    expect(interventionInfo("cancel")).toMatchObject({ mutates: true, targetState: "skipped" });
    for (const info of INTERVENTION_INFO) expect(info.description.length).toBeGreaterThan(0);
  });
});

describe("planIntervention: read-only interventions", () => {
  it("allows inspect and open-receipt without an ownership check or event", () => {
    // Even with a mismatched owner/head, read-only interventions are allowed.
    const inspect = planIntervention("inspect", "n1", ownership({ sessionOwner: "someone-else" }));
    expect(inspect.allowed).toBe(true);
    expect(inspect.event).toBeNull();
    const receipt = planIntervention("open-receipt", "n1", ownership({ currentHead: "b".repeat(40) }));
    expect(receipt.allowed).toBe(true);
    expect(receipt.event).toBeNull();
  });
});

describe("planIntervention: mutation-bearing interventions", () => {
  it("allows a mutation with valid ownership and records the correct lifecycle event", () => {
    const pause = planIntervention("pause", "n1", ownership());
    expect(pause.allowed).toBe(true);
    expect(pause.event).toEqual({ type: "node-transition", id: "n1", to: "waiting" });

    const approve = planIntervention("approve", "gate1", ownership());
    expect(approve.event).toEqual({ type: "node-transition", id: "gate1", to: "succeeded" });
  });

  it("refuses a mutation against an unowned session with the canonical semantic and no event", () => {
    const plan = planIntervention("cancel", "n1", ownership({ sessionOwner: "intruder" }));
    expect(plan.allowed).toBe(false);
    expect(plan.event).toBeNull();
    expect(plan.reason).toContain(conceptById("delivery-state").failureSemantic);
    expect(plan.reason).toContain("not owned");
  });

  it("refuses a mutation against a moved head with the canonical semantic and no event", () => {
    const moved = "b".repeat(40);
    const plan = planIntervention("resume", "n1", ownership({ currentHead: moved }));
    expect(plan.allowed).toBe(false);
    expect(plan.event).toBeNull();
    expect(plan.reason).toContain(conceptById("delivery-state").failureSemantic);
    expect(plan.reason).toContain(HEAD.slice(0, 12));
    expect(plan.reason).toContain(moved.slice(0, 12));
  });

  it("refuses an unknown intervention kind", () => {
    const plan = planIntervention("self-destruct" as never, "n1", ownership());
    expect(plan.allowed).toBe(false);
    expect(plan.event).toBeNull();
  });
});

describe("planned events integrate with the #313 projection", () => {
  it("an allowed intervention event transitions the target node when applied", () => {
    let model = replayEvents([
      { type: "node-added", id: "gate1", kind: "gate" },
      { type: "node-transition", id: "gate1", to: "waiting" },
    ]);
    const plan = planIntervention("approve", "gate1", ownership());
    expect(plan.allowed).toBe(true);
    model = reduceEvent(model, plan.event!);
    expect(nodeById(model, "gate1")!.state).toBe("succeeded");
  });

  it("a refused intervention produces no event, so the projection is unchanged", () => {
    const model = replayEvents([
      { type: "node-added", id: "gate1", kind: "gate" },
      { type: "node-transition", id: "gate1", to: "waiting" },
    ]);
    const plan = planIntervention("approve", "gate1", ownership({ sessionOwner: "intruder" }));
    expect(plan.event).toBeNull();
    expect(nodeById(model, "gate1")!.state).toBe("waiting");
  });
});

describe("collectInterventionDescriptor / formatInterventionDescriptor", () => {
  it("collects the static intervention contract", () => {
    const descriptor = collectInterventionDescriptor();
    expect(descriptor.schema).toBe(MISSION_INTERVENTION_SCHEMA);
    expect(descriptor.interventions.map((i) => i.kind)).toEqual([...INTERVENTION_KINDS]);
  });

  it("renders the contract with mutate/target information", () => {
    const out = formatInterventionDescriptor(collectInterventionDescriptor());
    expect(out).toContain(MISSION_INTERVENTION_SCHEMA);
    expect(out).toContain("inspect [read-only]");
    expect(out).toContain("pause [mutates -> waiting]");
    expect(out).toContain("approve [mutates -> succeeded]");
    expect(out).toContain("open-receipt [read-only]");
  });
});
