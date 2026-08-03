import { describe, it, expect } from "vitest";
import {
  assembleGoalList,
  formatGoalList,
  MAX_RECENT_COMPLETED,
  GOAL_LIST_SCHEMA,
  GOAL_LIST_VERSION,
} from "../../src/goal-list.js";
import type { GoalListInput } from "../../src/goal-list.js";

// Behavior-sensitive coverage for the Goal list projection (Issue #466):
// unified assembly, per-state counts, the completed cap and newest-first
// ordering, FIFO preservation, objective redaction, outcome markers, section
// placeholders, determinism, and input immutability.

const NOW = 5_000_000_000_000;

const EMPTY: GoalListInput = { current: null, queued: [], completed: [] };

// --- unified assembly and counts ----------------------------------------------

describe("unified assembly and counts", () => {
  it("unifies current, queued, and completed with accurate counts", () => {
    const view = assembleGoalList({
      current: { objective: "ship the release", status: "active", revision: 3, updatedAt: NOW },
      queued: [
        { objective: "write docs", queuedAt: NOW + 1 },
        { objective: "tag v2", queuedAt: NOW + 2 },
      ],
      completed: [
        { objective: "fix login", outcome: "achieved", revision: 2, updatedAt: NOW - 10 },
        { objective: "old probe", outcome: "failed", revision: 1, updatedAt: NOW - 20 },
      ],
    });
    expect(view.total).toBe(5);
    expect(view.counts.active).toBe(1);
    expect(view.counts.paused).toBe(0);
    expect(view.counts.queued).toBe(2);
    expect(view.counts.completed).toBe(2);
    expect(view.current?.objective).toBe("ship the release");
    expect(view.schema).toBe(GOAL_LIST_SCHEMA);
    expect(view.v).toBe(GOAL_LIST_VERSION);
  });

  it("counts a paused current Goal as paused", () => {
    const view = assembleGoalList({
      current: { objective: "paused work", status: "paused", revision: 1, updatedAt: NOW },
      queued: [],
      completed: [],
    });
    expect(view.counts.active).toBe(0);
    expect(view.counts.paused).toBe(1);
  });
});

// --- completed cap and ordering -------------------------------------------------

describe("completed cap and ordering", () => {
  it("bounds completed entries to the recent cap, newest first", () => {
    const completed = Array.from({ length: MAX_RECENT_COMPLETED + 5 }, (_, i) => ({
      objective: `done ${i}`,
      outcome: "achieved" as const,
      revision: 1,
      updatedAt: NOW - i * 1000, // i=0 is newest
    }));
    const view = assembleGoalList({ current: null, queued: [], completed });
    expect(view.completed.length).toBe(MAX_RECENT_COMPLETED);
    expect(view.completed[0].objective).toBe("done 0");
    expect(view.completed[view.completed.length - 1].objective).toBe(
      `done ${MAX_RECENT_COMPLETED - 1}`,
    );
  });

  it("sorts unsorted completed input newest first", () => {
    const view = assembleGoalList({
      current: null,
      queued: [],
      completed: [
        { objective: "older", outcome: "achieved", revision: 1, updatedAt: NOW - 5000 },
        { objective: "newest", outcome: "achieved", revision: 1, updatedAt: NOW },
        { objective: "middle", outcome: "failed", revision: 1, updatedAt: NOW - 2000 },
      ],
    });
    expect(view.completed.map((g) => g.objective)).toEqual(["newest", "middle", "older"]);
  });
});

// --- FIFO preservation -----------------------------------------------------------

describe("FIFO preservation", () => {
  it("keeps queued entries in the given order", () => {
    const view = assembleGoalList({
      current: null,
      queued: [
        { objective: "first", queuedAt: NOW },
        { objective: "second", queuedAt: NOW + 1 },
        { objective: "third", queuedAt: NOW + 2 },
      ],
      completed: [],
    });
    expect(view.queued.map((g) => g.objective)).toEqual(["first", "second", "third"]);
  });
});

// --- redaction ----------------------------------------------------------------------

describe("objective redaction", () => {
  it("redacts secret-shaped objectives in every section", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const view = assembleGoalList({
      current: { objective: `use ${token}`, status: "active", revision: 1, updatedAt: NOW },
      queued: [{ objective: `rotate ${token}`, queuedAt: NOW + 1 }],
      completed: [{ objective: `leaked ${token}`, outcome: "failed", revision: 1, updatedAt: NOW - 1 }],
    });
    expect(view.current?.objective).not.toContain(token);
    expect(view.queued[0].objective).not.toContain(token);
    expect(view.completed[0].objective).not.toContain(token);
    expect(view.current?.objective).toContain("[REDACTED]");
  });
});

// --- rendering ------------------------------------------------------------------------

describe("formatGoalList", () => {
  it("renders current, queued, and completed sections with outcome markers", () => {
    const view = assembleGoalList({
      current: { objective: "main push", status: "active", revision: 2, updatedAt: NOW },
      queued: [{ objective: "next up", queuedAt: NOW + 1 }],
      completed: [
        { objective: "won", outcome: "achieved", revision: 1, updatedAt: NOW - 1 },
        { objective: "lost", outcome: "failed", revision: 1, updatedAt: NOW - 2 },
        { objective: "dropped", outcome: "cancelled", revision: 1, updatedAt: NOW - 3 },
      ],
    });
    const output = formatGoalList(view);
    expect(output).toContain("Active: main push");
    expect(output).toContain("Queued: 1");
    expect(output).toContain("1. next up");
    expect(output).toContain("Recently completed: 3");
    expect(output).toContain("[achieved] won");
    expect(output).toContain("[failed] lost");
    expect(output).toContain("[cancelled] dropped");
  });

  it("renders a paused current Goal", () => {
    const output = formatGoalList(
      assembleGoalList({
        current: { objective: "on hold", status: "paused", revision: 1, updatedAt: NOW },
        queued: [],
        completed: [],
      }),
    );
    expect(output).toContain("Paused: on hold");
  });

  it("renders explicit placeholders for empty sections", () => {
    const output = formatGoalList(assembleGoalList(EMPTY));
    expect(output).toContain("Current: (none)");
    expect(output).toContain("(none queued)");
    expect(output).toContain("(none completed)");
  });

  it("is deterministic", () => {
    const input: GoalListInput = {
      current: { objective: "x", status: "active", revision: 1, updatedAt: NOW },
      queued: [{ objective: "y", queuedAt: NOW + 1 }],
      completed: [{ objective: "z", outcome: "achieved", revision: 1, updatedAt: NOW - 1 }],
    };
    expect(formatGoalList(assembleGoalList(input))).toBe(
      formatGoalList(assembleGoalList(input)),
    );
  });
});

// --- purity -------------------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input", () => {
    const input: GoalListInput = {
      current: { objective: "c", status: "active", revision: 1, updatedAt: NOW },
      queued: [{ objective: "q", queuedAt: NOW + 1 }],
      completed: [
        { objective: "b", outcome: "achieved", revision: 1, updatedAt: NOW - 1 },
        { objective: "a", outcome: "failed", revision: 1, updatedAt: NOW - 2 },
      ],
    };
    const snapshot = JSON.stringify(input);
    assembleGoalList(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
