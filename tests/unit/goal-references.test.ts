import { describe, it, expect } from "vitest";
import {
  emptyGoalLinks,
  addGoalReference,
  removeGoalReference,
  childrenOf,
  parentOf,
  assembleGoalReferenceView,
  formatGoalReferenceView,
  GOAL_REFERENCES_SCHEMA,
  GOAL_REFERENCES_VERSION,
} from "../../src/goal-references.js";
import type { GoalLinkState, GoalNodeInfo } from "../../src/goal-references.js";

// Behavior-sensitive coverage for Goal references (Issue #470): add/remove,
// insertion order, single-parent enforcement, refusal classes (self,
// duplicate, second parent, cycle), individual-state rendering, the
// no-children placeholder, determinism, and input immutability.

const nodes: Record<string, GoalNodeInfo> = {
  parent: { goalId: "parent", objective: "ship the release", status: "active" },
  a: { goalId: "a", objective: "write tests", status: "active" },
  b: { goalId: "b", objective: "update docs", status: "paused" },
  c: { goalId: "c", objective: "tag version", status: "achieved" },
};

const linked = (): GoalLinkState => {
  let state = emptyGoalLinks();
  state = addGoalReference(state, "parent", "a").state;
  state = addGoalReference(state, "parent", "b").state;
  state = addGoalReference(state, "parent", "c").state;
  return state;
};

// --- add / remove / lookups -----------------------------------------------------

describe("add, remove, and lookups", () => {
  it("adds references and lists children in insertion order", () => {
    const state = linked();
    expect(childrenOf(state, "parent")).toEqual(["a", "b", "c"]);
    expect(parentOf(state, "a")).toBe("parent");
    expect(parentOf(state, "missing")).toBeNull();
  });

  it("removes an existing reference", () => {
    const state = linked();
    const result = removeGoalReference(state, "parent", "b");
    expect(result.ok).toBe(true);
    expect(childrenOf(result.state, "parent")).toEqual(["a", "c"]);
    expect(parentOf(result.state, "b")).toBeNull();
  });

  it("refuses to remove a nonexistent reference", () => {
    const result = removeGoalReference(linked(), "parent", "zz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no such reference");
    }
  });
});

// --- refusal classes -------------------------------------------------------------

describe("refusal classes", () => {
  it("refuses a self-reference", () => {
    const result = addGoalReference(emptyGoalLinks(), "a", "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("itself");
    }
  });

  it("refuses a duplicate reference", () => {
    const result = addGoalReference(linked(), "parent", "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("already exists");
    }
  });

  it("refuses a child that already has a parent", () => {
    const result = addGoalReference(linked(), "other", "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("already has a parent");
    }
  });

  it("refuses a direct cycle", () => {
    let state = emptyGoalLinks();
    state = addGoalReference(state, "a", "b").state;
    const result = addGoalReference(state, "b", "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cycle");
    }
  });

  it("refuses a multi-hop cycle", () => {
    let state = emptyGoalLinks();
    state = addGoalReference(state, "a", "b").state;
    state = addGoalReference(state, "b", "c").state;
    const result = addGoalReference(state, "c", "a");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cycle");
    }
  });
});

// --- individual-state rendering ----------------------------------------------------

describe("individual-state rendering", () => {
  it("shows each child with its own objective and status verbatim", () => {
    const view = assembleGoalReferenceView(linked(), nodes, "parent");
    expect(view.parent.objective).toBe("ship the release");
    expect(view.parent.status).toBe("active");
    expect(view.childCount).toBe(3);
    expect(view.children.map((c) => c.status)).toEqual(["active", "paused", "achieved"]);
    expect(view.schema).toBe(GOAL_REFERENCES_SCHEMA);
    expect(view.v).toBe(GOAL_REFERENCES_VERSION);

    const output = formatGoalReferenceView(view);
    expect(output).toContain("Parent: ship the release [active]");
    expect(output).toContain("Children: 3");
    expect(output).toContain("1. write tests [active]");
    expect(output).toContain("2. update docs [paused]");
    expect(output).toContain("3. tag version [achieved]");
  });

  it("renders an explicit placeholder when there are no children", () => {
    const view = assembleGoalReferenceView(emptyGoalLinks(), nodes, "parent");
    const output = formatGoalReferenceView(view);
    expect(output).toContain("Children: 0");
    expect(output).toContain("(no referenced children)");
  });

  it("redacts secret-shaped child objectives while keeping status visible", () => {
    const token = ["ghp", "_", "a".repeat(24)].join("");
    const secretNodes: Record<string, GoalNodeInfo> = {
      p: { goalId: "p", objective: "parent", status: "active" },
      x: { goalId: "x", objective: `rotate ${token}`, status: "paused" },
    };
    let state = emptyGoalLinks();
    state = addGoalReference(state, "p", "x").state;
    const output = formatGoalReferenceView(assembleGoalReferenceView(state, secretNodes, "p"));
    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[paused]");
  });
});

// --- determinism and purity -----------------------------------------------------------

describe("determinism and purity", () => {
  it("is deterministic", () => {
    const state = linked();
    expect(formatGoalReferenceView(assembleGoalReferenceView(state, nodes, "parent"))).toBe(
      formatGoalReferenceView(assembleGoalReferenceView(state, nodes, "parent")),
    );
  });

  it("does not mutate the input state", () => {
    const state = linked();
    const snapshot = JSON.stringify(state);
    addGoalReference(state, "parent", "zz");
    removeGoalReference(state, "parent", "a");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
