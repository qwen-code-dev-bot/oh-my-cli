import { describe, it, expect } from "vitest";
import {
  assembleGoalProvenance,
  formatGoalProvenance,
  PROVENANCE_ORIGIN_ORDER,
  GOAL_PROVENANCE_SCHEMA,
  GOAL_PROVENANCE_VERSION,
} from "../../src/goal-provenance.js";
import type { ProvenanceRecord } from "../../src/goal-provenance.js";

// Behavior-sensitive coverage for Goal provenance (Issue #462): origin-class
// preservation and counts, chronological ordering with deterministic
// tie-break, redaction, bounding, manual-override surfacing, empty input,
// rendering, and determinism.

const NOW = 2_000_000_000_000;

const record = (over: Partial<ProvenanceRecord>): ProvenanceRecord => ({
  origin: "model-decision",
  actor: "model",
  detail: "chose the faster algorithm",
  timestamp: NOW,
  goalRevision: 1,
  attempt: 1,
  ...over,
});

// --- origin preservation and counts -----------------------------------------

describe("origin preservation and counts", () => {
  it("preserves all four origin classes and counts them", () => {
    const view = assembleGoalProvenance([
      record({ origin: "user-instruction", actor: "user", detail: "focus on tests" }),
      record({ origin: "model-decision", detail: "split the refactor" }),
      record({ origin: "tool-result", actor: "shell", detail: "build passed" }),
      record({ origin: "manual-override", actor: "user", detail: "skipped the deploy step" }),
    ]);
    expect(view.totalRecords).toBe(4);
    expect(view.counts["user-instruction"]).toBe(1);
    expect(view.counts["model-decision"]).toBe(1);
    expect(view.counts["tool-result"]).toBe(1);
    expect(view.counts["manual-override"]).toBe(1);
    expect(view.schema).toBe(GOAL_PROVENANCE_SCHEMA);
    expect(view.v).toBe(GOAL_PROVENANCE_VERSION);
  });

  it("counts multiple records per origin", () => {
    const view = assembleGoalProvenance([
      record({ origin: "tool-result", detail: "a" }),
      record({ origin: "tool-result", detail: "b" }),
      record({ origin: "tool-result", detail: "c" }),
      record({ origin: "model-decision" }),
    ]);
    expect(view.counts["tool-result"]).toBe(3);
    expect(view.counts["model-decision"]).toBe(1);
    expect(view.counts["user-instruction"]).toBe(0);
  });
});

// --- ordering ------------------------------------------------------------------

describe("chronological ordering and tie-break", () => {
  it("orders records by timestamp ascending", () => {
    const view = assembleGoalProvenance([
      record({ detail: "third", timestamp: NOW + 30 }),
      record({ detail: "first", timestamp: NOW + 10 }),
      record({ detail: "second", timestamp: NOW + 20 }),
    ]);
    expect(view.records.map((r) => r.detail)).toEqual(["first", "second", "third"]);
  });

  it("breaks equal timestamps deterministically by origin then detail", () => {
    const view = assembleGoalProvenance([
      record({ origin: "tool-result", detail: "zeta", timestamp: NOW }),
      record({ origin: "model-decision", detail: "beta", timestamp: NOW }),
      record({ origin: "model-decision", detail: "alpha", timestamp: NOW }),
      record({ origin: "user-instruction", detail: "gamma", timestamp: NOW }),
    ]);
    // origin localeCompare: model-decision < tool-result < user-instruction
    expect(view.records.map((r) => r.detail)).toEqual([
      "alpha",
      "beta",
      "zeta",
      "gamma",
    ]);
  });
});

// --- redaction and bounding -----------------------------------------------------

describe("redaction and bounding", () => {
  it("redacts secret-shaped details and actors", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const view = assembleGoalProvenance([
      record({ detail: `ran with ${token}`, actor: `agent ${token}` }),
    ]);
    expect(view.records[0].detail).not.toContain(token);
    expect(view.records[0].detail).toContain("[REDACTED]");
    expect(view.records[0].actor).not.toContain(token);
    expect(view.records[0].actor).toContain("[REDACTED]");
  });

  it("bounds over-long details with an ellipsis", () => {
    const view = assembleGoalProvenance([record({ detail: "x".repeat(500) })]);
    expect(view.records[0].detail.length).toBeLessThanOrEqual(300);
    expect(view.records[0].detail.endsWith("…")).toBe(true);
  });

  it("bounds over-long actors", () => {
    const view = assembleGoalProvenance([record({ actor: "y".repeat(200) })]);
    expect(view.records[0].actor.length).toBeLessThanOrEqual(100);
  });

  it("strips control characters", () => {
    const view = assembleGoalProvenance([record({ detail: "a\u0000b\u202ec" })]);
    expect(view.records[0].detail).not.toContain("\u0000");
    expect(view.records[0].detail).not.toContain("\u202e");
  });
});

// --- manual overrides -----------------------------------------------------------

describe("manual override surfacing", () => {
  it("lists overrides distinctly while keeping them in the ordered records", () => {
    const view = assembleGoalProvenance([
      record({ origin: "manual-override", detail: "cancelled the run", timestamp: NOW + 5 }),
      record({ origin: "model-decision", detail: "continued", timestamp: NOW + 1 }),
    ]);
    expect(view.overrides.length).toBe(1);
    expect(view.overrides[0].detail).toBe("cancelled the run");
    expect(view.records.length).toBe(2);
    expect(view.records.some((r) => r.origin === "manual-override")).toBe(true);
  });

  it("reports zero overrides when none exist", () => {
    const view = assembleGoalProvenance([record({ origin: "model-decision" })]);
    expect(view.overrides).toEqual([]);
  });
});

// --- empty input -----------------------------------------------------------------

describe("empty input", () => {
  it("produces an empty view with zero counts", () => {
    const view = assembleGoalProvenance([]);
    expect(view.totalRecords).toBe(0);
    expect(view.records).toEqual([]);
    expect(view.overrides).toEqual([]);
    for (const origin of PROVENANCE_ORIGIN_ORDER) {
      expect(view.counts[origin]).toBe(0);
    }
  });
});

// --- formatting --------------------------------------------------------------------

describe("formatGoalProvenance", () => {
  it("renders counts and per-record lines", () => {
    const view = assembleGoalProvenance([
      record({ origin: "user-instruction", actor: "user", detail: "keep it simple", timestamp: NOW }),
      record({ origin: "manual-override", actor: "user", detail: "stopped the run", timestamp: NOW + 2 }),
    ]);
    const output = formatGoalProvenance(view);
    expect(output).toContain(GOAL_PROVENANCE_SCHEMA);
    expect(output).toContain("Records: 2 (user-instruction: 1, model-decision: 0, tool-result: 0, manual-override: 1)");
    expect(output).toContain("[user-instruction] keep it simple");
    expect(output).toContain("[manual-override] stopped the run");
    expect(output).toContain("Manual overrides: 1");
  });

  it("never includes secret material", () => {
    const token = ["ghp", "_", "b".repeat(24)].join("");
    const view = assembleGoalProvenance([record({ detail: `leak ${token}` })]);
    const output = formatGoalProvenance(view);
    expect(output).not.toContain(token);
  });

  it("is deterministic", () => {
    const records = [
      record({ detail: "b", timestamp: NOW }),
      record({ detail: "a", timestamp: NOW }),
    ];
    expect(formatGoalProvenance(assembleGoalProvenance(records))).toBe(
      formatGoalProvenance(assembleGoalProvenance(records)),
    );
  });
});

// --- purity -------------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input records", () => {
    const token = ["ghp", "_", "c".repeat(24)].join("");
    const input = [record({ detail: `x ${token}` })];
    const snapshot = JSON.stringify(input);
    assembleGoalProvenance(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
