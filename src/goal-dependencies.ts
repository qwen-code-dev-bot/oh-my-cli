// Goal dependency edges: machine-readable ordering dependencies between
// Goals, distinct from parent/child composition (src/goal-references.ts).
//
// An edge (goalId, dependsOn) means goalId depends on the outcome of
// dependsOn. Edges are added and removed safely (self-dependencies,
// duplicates, and cycles are refused), lookups expose both directions, and a
// schema-versioned view makes the graph machine-readable while a
// deterministic rendering makes it visible. The model is pure: every
// operation returns new state, never mutates its inputs, and never touches
// persistence.

export const GOAL_DEPENDENCIES_SCHEMA = "oh-my-cli.goal-dependencies";
export const GOAL_DEPENDENCIES_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface GoalDependencyEdge {
  /** The dependent Goal. */
  goalId: string;
  /** The Goal whose outcome is depended on. */
  dependsOn: string;
}

export interface GoalDependencyState {
  /** Dependency edges in insertion order. */
  edges: GoalDependencyEdge[];
}

export type GoalDependencyResult =
  | { ok: true; state: GoalDependencyState }
  | { ok: false; state: GoalDependencyState; reason: string };

export interface GoalDependencyView {
  schema: typeof GOAL_DEPENDENCIES_SCHEMA;
  v: typeof GOAL_DEPENDENCIES_VERSION;
  edgeCount: number;
  edges: GoalDependencyEdge[];
}

// --- edge operations ----------------------------------------------------------

/** An empty dependency graph. */
export function emptyGoalDependencies(): GoalDependencyState {
  return { edges: [] };
}

// True when `fromId` transitively depends on `targetId` (following
// dependency edges). Used to refuse cycles.
function dependsOnTransitively(
  state: GoalDependencyState,
  fromId: string,
  targetId: string,
): boolean {
  const visited = new Set<string>();
  const stack: string[] = [fromId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of state.edges) {
      if (edge.goalId === current) stack.push(edge.dependsOn);
    }
  }
  return false;
}

// Add a dependency edge: goalId depends on dependsOn. Refuses
// self-dependencies, duplicate edges, and cycles (direct and multi-hop) with
// actionable reasons. Returns new state on success or an actionable refusal;
// never mutates the input.
export function addGoalDependency(
  state: GoalDependencyState,
  goalId: string,
  dependsOn: string,
): GoalDependencyResult {
  if (goalId === dependsOn) {
    return { ok: false, state, reason: "a Goal cannot depend on itself" };
  }
  if (state.edges.some((e) => e.goalId === goalId && e.dependsOn === dependsOn)) {
    return { ok: false, state, reason: "this dependency already exists" };
  }
  if (dependsOnTransitively(state, dependsOn, goalId)) {
    return { ok: false, state, reason: "adding this dependency would create a cycle" };
  }
  return { ok: true, state: { edges: [...state.edges, { goalId, dependsOn }] } };
}

// Remove a dependency edge. Refuses when the edge does not exist. Returns new
// state on success or an actionable refusal; never mutates the input.
export function removeGoalDependency(
  state: GoalDependencyState,
  goalId: string,
  dependsOn: string,
): GoalDependencyResult {
  if (!state.edges.some((e) => e.goalId === goalId && e.dependsOn === dependsOn)) {
    return { ok: false, state, reason: "no such dependency to remove" };
  }
  return {
    ok: true,
    state: {
      edges: state.edges.filter(
        (e) => !(e.goalId === goalId && e.dependsOn === dependsOn),
      ),
    },
  };
}

// --- lookups --------------------------------------------------------------------

/** What goalId depends on, in insertion order. */
export function dependenciesOf(state: GoalDependencyState, goalId: string): string[] {
  return state.edges.filter((e) => e.goalId === goalId).map((e) => e.dependsOn);
}

/** Goals that depend on goalId, in insertion order. */
export function dependentsOf(state: GoalDependencyState, goalId: string): string[] {
  return state.edges.filter((e) => e.dependsOn === goalId).map((e) => e.goalId);
}

// Goals appearing as dependents whose dependencies are all in the satisfied
// set, in first-appearance order. A Goal with multiple dependencies is
// unblocked only when every one is satisfied.
export function unblockedGoals(
  state: GoalDependencyState,
  satisfied: readonly string[],
): string[] {
  const satisfiedSet = new Set(satisfied);
  const dependents: string[] = [];
  for (const edge of state.edges) {
    if (!dependents.includes(edge.goalId)) dependents.push(edge.goalId);
  }
  return dependents.filter((goalId) =>
    state.edges
      .filter((e) => e.goalId === goalId)
      .every((e) => satisfiedSet.has(e.dependsOn)),
  );
}

// --- view and formatting -----------------------------------------------------------

// Project the dependency graph as a schema-versioned, machine-readable view.
// Never mutates the input.
export function assembleGoalDependencyView(state: GoalDependencyState): GoalDependencyView {
  return {
    schema: GOAL_DEPENDENCIES_SCHEMA,
    v: GOAL_DEPENDENCIES_VERSION,
    edgeCount: state.edges.length,
    edges: state.edges.map((e) => ({ goalId: e.goalId, dependsOn: e.dependsOn })),
  };
}

export function formatGoalDependencyView(view: GoalDependencyView): string {
  const lines: string[] = [];
  lines.push(`Goal dependencies (${view.schema} v${view.v})`);
  lines.push(`Edges: ${view.edgeCount}`);
  if (view.edgeCount === 0) {
    lines.push("  (no dependency edges)");
  } else {
    view.edges.forEach((edge, index) => {
      lines.push(`  ${index + 1}. ${edge.goalId} depends on ${edge.dependsOn}`);
    });
  }
  return lines.join("\n");
}
