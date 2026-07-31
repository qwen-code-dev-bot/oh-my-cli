// Lifecycle rendering: render the durable lifecycle projection (#313) as a
// read-only timeline and dependency graph for the mission-control TUI view
// (Issue #314, the read-only visualization child of #297). The rendering is a
// pure function of the projection: a node appears or changes in the view only
// because the projection changed, so the view never shows state the durable
// events did not produce, and the same projection always renders the same view.
//
// This module returns plain text lines (no ANSI); the TUI panel in tui-shell.ts
// applies color/style around them, exactly as the background-task panel styles
// formatTaskView output. Keeping rendering pure and style-free makes it
// unit-testable against fixture projections and reusable by the Desktop canvas
// (#318) and the cross-surface parity proof (#319).
//
// Trust boundary: the rendering reads only the projection (already sanitized
// when built); it executes nothing and adds no untrusted content.

import type { LifecycleModel, LifecycleNode, NodeState } from "./lifecycle-projection.js";

// A stable glyph per node state, so the view communicates state at a glance.
const STATE_GLYPHS: Record<NodeState, string> = {
  pending: "○",
  active: "◆",
  waiting: "◇",
  succeeded: "✓",
  failed: "✕",
  skipped: "⊘",
};

// A short label per node kind for compact rendering.
const KIND_LABELS: Record<LifecycleNode["kind"], string> = {
  goal: "goal",
  phase: "phase",
  gate: "gate",
  retry: "retry",
  budget: "budget",
  outcome: "outcome",
};

export function stateGlyph(state: NodeState): string {
  return STATE_GLYPHS[state] ?? "?";
}

// Render one node as a single timeline line: "<glyph> <label> [<kind>] <state>".
export function renderNodeLine(node: LifecycleNode): string {
  const label = node.label || node.id;
  return `${stateGlyph(node.state)} ${label} [${KIND_LABELS[node.kind]}] ${node.state}`;
}

// Render the projection as a vertical timeline of its nodes (in projection
// order). Empty projection renders a single placeholder line.
export function renderLifecycleTimeline(model: LifecycleModel): string[] {
  if (model.nodes.length === 0) return ["(no mission activity)"];
  return model.nodes.map(renderNodeLine);
}

// Render the dependency edges as "<from> -> <to>" lines. Edges are rendered in
// projection order; an empty edge set renders a single placeholder line.
export function renderLifecycleGraph(model: LifecycleModel): string[] {
  if (model.edges.length === 0) return ["(no dependencies)"];
  const labelOf = (id: string): string => {
    const node = model.nodes.find((n) => n.id === id);
    return node ? node.label || node.id : id;
  };
  return model.edges.map((edge) => `${labelOf(edge.from)} -> ${labelOf(edge.to)}`);
}

// A short parity/progress summary line: counts of active, waiting, failed, and
// terminal nodes, plus the projection revision.
export function renderLifecycleSummary(model: LifecycleModel): string {
  const count = (state: NodeState): number =>
    model.nodes.filter((n) => n.state === state).length;
  const terminal = model.nodes.filter(
    (n) => n.state === "succeeded" || n.state === "failed" || n.state === "skipped",
  ).length;
  return (
    `nodes ${model.nodes.length} · active ${count("active")} · waiting ${count("waiting")} · ` +
    `failed ${count("failed")} · terminal ${terminal} · rev ${model.revision}`
  );
}

// Render the full read-only mission view: header context, the timeline, the
// dependency graph, and a summary line. Pure and deterministic.
export function formatLifecycleView(model: LifecycleModel): string[] {
  return [
    `Mission lifecycle (read-only) · ${renderLifecycleSummary(model)}`,
    "",
    "Timeline:",
    ...renderLifecycleTimeline(model).map((line) => `  ${line}`),
    "",
    "Dependencies:",
    ...renderLifecycleGraph(model).map((line) => `  ${line}`),
  ];
}
