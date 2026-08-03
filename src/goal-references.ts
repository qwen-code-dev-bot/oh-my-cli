// Goal references: lets a parent Goal reference focused child Goals without
// hiding their individual states.
//
// A broad Goal often decomposes into focused child Goals. This model relates
// Goals to each other as a forest: each child has at most one parent, cycles
// are refused, and the reference view always shows each child with its own
// individual status — states are surfaced, never merged or hidden. The model
// is pure: every operation returns new state, never mutates its inputs, and
// never touches persistence.

import { redactSecrets } from "./permission-impact.js";

export const GOAL_REFERENCES_SCHEMA = "oh-my-cli.goal-references";
export const GOAL_REFERENCES_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface GoalLink {
  parentId: string;
  childId: string;
}

export interface GoalLinkState {
  /** Parent→child references in insertion order. */
  links: GoalLink[];
}

export type GoalReferenceResult =
  | { ok: true; state: GoalLinkState }
  | { ok: false; state: GoalLinkState; reason: string };

/** A Goal's own identity and state, supplied by the caller. */
export interface GoalNodeInfo {
  goalId: string;
  objective: string;
  /** The Goal's individual status (e.g. active, paused, achieved, failed). */
  status: string;
}

export interface GoalReferenceEntry {
  goalId: string;
  /** Sanitized, redacted objective. */
  objective: string;
  /** The Goal's individual status, surfaced verbatim (sanitized). */
  status: string;
}

export interface GoalReferenceView {
  schema: typeof GOAL_REFERENCES_SCHEMA;
  v: typeof GOAL_REFERENCES_VERSION;
  parent: GoalReferenceEntry;
  /** Children in insertion order, each with its own individual status. */
  children: GoalReferenceEntry[];
  childCount: number;
}

// --- sanitization -----------------------------------------------------------

function safeText(value: string): string {
  const terminalSafe = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return redactSecrets(terminalSafe).text;
}

// --- link operations ----------------------------------------------------------

/** An empty reference forest. */
export function emptyGoalLinks(): GoalLinkState {
  return { links: [] };
}

// True when `maybeAncestorId` is an ancestor of `ofId` (following parent
// links upward). Used to refuse reference cycles.
function isAncestor(state: GoalLinkState, maybeAncestorId: string, ofId: string): boolean {
  let current = ofId;
  const seen = new Set<string>();
  for (;;) {
    const link = state.links.find((l) => l.childId === current);
    if (!link) return false;
    if (link.parentId === maybeAncestorId) return true;
    if (seen.has(link.parentId)) return false;
    seen.add(link.parentId);
    current = link.parentId;
  }
}

// Add a reference from a parent Goal to a child Goal. Refuses
// self-references, duplicate references, a child that already has a parent,
// and cycles. Returns new state on success or an actionable refusal; never
// mutates the input.
export function addGoalReference(
  state: GoalLinkState,
  parentId: string,
  childId: string,
): GoalReferenceResult {
  if (parentId === childId) {
    return { ok: false, state, reason: "a Goal cannot reference itself as a child" };
  }
  if (state.links.some((l) => l.parentId === parentId && l.childId === childId)) {
    return { ok: false, state, reason: "this reference already exists" };
  }
  if (state.links.some((l) => l.childId === childId)) {
    return { ok: false, state, reason: "the child Goal already has a parent" };
  }
  if (isAncestor(state, childId, parentId)) {
    return { ok: false, state, reason: "adding this reference would create a cycle" };
  }
  return { ok: true, state: { links: [...state.links, { parentId, childId }] } };
}

// Remove a reference. Refuses when the reference does not exist. Returns new
// state on success or an actionable refusal; never mutates the input.
export function removeGoalReference(
  state: GoalLinkState,
  parentId: string,
  childId: string,
): GoalReferenceResult {
  if (!state.links.some((l) => l.parentId === parentId && l.childId === childId)) {
    return { ok: false, state, reason: "no such reference to remove" };
  }
  return {
    ok: true,
    state: {
      links: state.links.filter(
        (l) => !(l.parentId === parentId && l.childId === childId),
      ),
    },
  };
}

/** Child ids of a parent, in insertion order. */
export function childrenOf(state: GoalLinkState, parentId: string): string[] {
  return state.links.filter((l) => l.parentId === parentId).map((l) => l.childId);
}

/** The parent of a child, or null (a child has at most one parent). */
export function parentOf(state: GoalLinkState, childId: string): string | null {
  const link = state.links.find((l) => l.childId === childId);
  return link ? link.parentId : null;
}

// --- view and formatting --------------------------------------------------------

function toEntry(info: GoalNodeInfo | undefined, goalId: string): GoalReferenceEntry {
  return {
    goalId,
    objective: safeText(info?.objective ?? "(unknown)"),
    status: safeText(info?.status ?? "unknown"),
  };
}

// Project a parent and its children. Each child entry carries its own
// objective and individual status verbatim — individual states are surfaced,
// never merged or hidden. Never mutates the input.
export function assembleGoalReferenceView(
  state: GoalLinkState,
  nodes: Record<string, GoalNodeInfo>,
  rootId: string,
): GoalReferenceView {
  const children = childrenOf(state, rootId).map((id) => toEntry(nodes[id], id));
  return {
    schema: GOAL_REFERENCES_SCHEMA,
    v: GOAL_REFERENCES_VERSION,
    parent: toEntry(nodes[rootId], rootId),
    children,
    childCount: children.length,
  };
}

export function formatGoalReferenceView(view: GoalReferenceView): string {
  const lines: string[] = [];
  lines.push(`Goal references (${view.schema} v${view.v})`);
  lines.push(`Parent: ${view.parent.objective} [${view.parent.status}]`);
  lines.push(`Children: ${view.childCount}`);
  if (view.childCount === 0) {
    lines.push("  (no referenced children)");
  } else {
    view.children.forEach((child, index) => {
      lines.push(`  ${index + 1}. ${child.objective} [${child.status}]`);
    });
  }
  return lines.join("\n");
}
