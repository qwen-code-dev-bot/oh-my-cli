import { describe, it, expect } from "vitest";
import {
  emptyGoalDependencies,
  addGoalDependency,
  removeGoalDependency,
  dependenciesOf,
  dependentsOf,
  unblockedGoals,
  assembleGoalDependencyView,
  formatGoalDependencyView,
  GOAL_DEPENDENCIES_SCHEMA,
  GOAL_DEPENDENCIES_VERSION,
} from "../../src/goal-dependencies.js";
import type { GoalDependencyState } from "../../src/goal-dependencies.js";

// Behavior-sensitive coverage for Goal dependency edges (Issue #475):
// add/remove, bidirectional insertion-ordered lookups, refusal classes
// (self, duplicate, direct and multi-hop cycles), multiple dependencies,
// unblocked computation, the machine-readable view, rendering, determinism,
// and input immutability.

const chain = (): GoalDependencyState => {
  // A depends on B; B depends on C. Plus D depends on E (independent).
  let state = emptyGoalDependencies();
  state = addGoalDependency(state, "A", "B").state;
  state = addGoalDependency(state, "B", "C").state;
  state = addGoalDependency(state, "D", "E").state;
  return state;
};

// --- add / remove / lookups -----------------------------------------------------

describe("add, remove, and lookups", () => {
  it("adds edges and lists dependencies in insertion order", () => {
    let state = emptyGoalDependencies();
    state = addGoalDependency(state, "A", "B").state;
    state = addGoalDependency(state, "A", "C").state;
    expect(dependenciesOf(state, "A")).toEqual(["B", "C"]);
  });

  it("lists dependents in insertion order", () => {
    let state = emptyGoalDependencies();
    state = addGoalDependency(state, "X", "Z").state;
    state = addGoalDependency(state, "Y", "Z").state;
    expect(dependentsOf(state, "Z")).toEqual(["X", "Y"]);
  });

  it("removes an existing edge and refuses a nonexistent one", () => {
    const state = chain();
    const removed = removeGoalDependency(state, "A", "B");
    expect(removed.ok).toBe(true);
    expect(dependenciesOf(removed.state, "A")).toEqual([]);

    const missing = removeGoalDependency(state, "A", "zz");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain("no such dependency");
    }
  });
});

// --- refusal classes -------------------------------------------------------------

describe("refusal classes", () => {
  it("refuses a self-dependency", () => {
    const result = addGoalDependency(emptyGoalDependencies(), "A", "A");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("itself");
    }
  });

  it("refuses a duplicate edge", () => {
    const state = chain();
    const result = addGoalDependency(state, "A", "B");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("already exists");
    }
  });

  it("refuses a direct cycle", () => {
    let state = emptyGoalDependencies();
    state = addGoalDependency(state, "A", "B").state;
    const result = addGoalDependency(state, "B", "A");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cycle");
    }
  });

  it("refuses a multi-hop cycle", () => {
    const state = chain(); // A->B->C
    const result = addGoalDependency(state, "C", "A");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cycle");
    }
  });
});

// --- multiple dependencies ---------------------------------------------------------

describe("multiple dependencies", () => {
  it("allows one Goal to depend on several Goals", () => {
    let state = emptyGoalDependencies();
    state = addGoalDependency(state, "A", "B").state;
    state = addGoalDependency(state, "A", "C").state;
    state = addGoalDependency(state, "A", "D").state;
    expect(dependenciesOf(state, "A")).toEqual(["B", "C", "D"]);
    expect(state.edges.length).toBe(3);
  });
});

// --- unblocked computation ------------------------------------------------------------

describe("unblockedGoals", () => {
  it("releases Goals only when every dependency is satisfied", () => {
    const state = chain(); // A->B, B->C, D->E
    expect(unblockedGoals(state, [])).toEqual([]);
    expect(unblockedGoals(state, ["C"])).toEqual(["B"]);
    // "Unblocked" means all of a Goal's dependencies are satisfied, so B
    // remains unblocked alongside A once both C and B are satisfied.
    expect(unblockedGoals(state, ["C", "B"])).toEqual(["A", "B"]);
    expect(unblockedGoals(state, ["C", "B", "E"])).toEqual(["A", "B", "D"]);
  });

  it("requires all of a multi-dependency Goal's dependencies", () => {
    let state = emptyGoalDependencies();
    state = addGoalDependency(state, "A", "B").state;
    state = addGoalDependency(state, "A", "C").state;
    expect(unblockedGoals(state, ["B"])).toEqual([]);
    expect(unblockedGoals(state, ["B", "C"])).toEqual(["A"]);
  });
});

// --- view and rendering -----------------------------------------------------------------

describe("view and rendering", () => {
  it("produces a schema-versioned machine-readable view", () => {
    const view = assembleGoalDependencyView(chain());
    expect(view.schema).toBe(GOAL_DEPENDENCIES_SCHEMA);
    expect(view.v).toBe(GOAL_DEPENDENCIES_VERSION);
    expect(view.edgeCount).toBe(3);
    expect(view.edges[0]).toEqual({ goalId: "A", dependsOn: "B" });
  });

  it("renders edges deterministically", () => {
    const output = formatGoalDependencyView(assembleGoalDependencyView(chain()));
    expect(output).toContain("Edges: 3");
    expect(output).toContain("1. A depends on B");
    expect(output).toContain("2. B depends on C");
    expect(output).toContain("3. D depends on E");
  });

  it("renders an explicit placeholder when there are no edges", () => {
    const output = formatGoalDependencyView(assembleGoalDependencyView(emptyGoalDependencies()));
    expect(output).toContain("Edges: 0");
    expect(output).toContain("(no dependency edges)");
  });

  it("is deterministic", () => {
    const state = chain();
    expect(formatGoalDependencyView(assembleGoalDependencyView(state))).toBe(
      formatGoalDependencyView(assembleGoalDependencyView(state)),
    );
  });
});

// --- purity ---------------------------------------------------------------------------------

describe("purity", () => {
  it("does not mutate the input state", () => {
    const state = chain();
    const snapshot = JSON.stringify(state);
    addGoalDependency(state, "Z", "A");
    removeGoalDependency(state, "A", "B");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
