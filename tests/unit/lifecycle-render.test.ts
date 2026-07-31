import { describe, it, expect } from "vitest";
import {
  stateGlyph,
  renderNodeLine,
  renderLifecycleTimeline,
  renderLifecycleGraph,
  renderLifecycleSummary,
  formatLifecycleView,
} from "../../src/lifecycle-render.js";
import { replayEvents, emptyLifecycleModel } from "../../src/lifecycle-projection.js";
import type { LifecycleEvent, LifecycleNode } from "../../src/lifecycle-projection.js";
import { renderLifecyclePanel, shellStyle } from "../../src/tui-shell.js";

const missionLog: LifecycleEvent[] = [
  { type: "node-added", id: "goal", kind: "goal", label: "Ship" },
  { type: "node-added", id: "build", kind: "phase", label: "Build" },
  { type: "node-added", id: "deploy", kind: "phase", label: "Deploy" },
  { type: "edge-added", from: "deploy", to: "build" },
  { type: "node-added", id: "gate", kind: "gate", label: "Approve" },
  { type: "node-transition", id: "goal", to: "active" },
  { type: "node-transition", id: "build", to: "succeeded" },
  { type: "node-transition", id: "gate", to: "waiting" },
];

const model = replayEvents(missionLog);

describe("stateGlyph", () => {
  it("maps each canonical state to a stable glyph", () => {
    expect(stateGlyph("pending")).toBe("○");
    expect(stateGlyph("active")).toBe("◆");
    expect(stateGlyph("waiting")).toBe("◇");
    expect(stateGlyph("succeeded")).toBe("✓");
    expect(stateGlyph("failed")).toBe("✕");
    expect(stateGlyph("skipped")).toBe("⊘");
  });
});

describe("renderLifecycleTimeline", () => {
  it("renders one line per node with glyph, label, kind, and state", () => {
    const lines = renderLifecycleTimeline(model);
    expect(lines).toContain("◆ Ship [goal] active");
    expect(lines).toContain("✓ Build [phase] succeeded");
    expect(lines).toContain("◇ Approve [gate] waiting");
    expect(lines).toContain("○ Deploy [phase] pending");
  });

  it("renders a placeholder for an empty projection", () => {
    expect(renderLifecycleTimeline(emptyLifecycleModel())).toEqual(["(no mission activity)"]);
  });

  it("falls back to the node id when no label is set", () => {
    const node: LifecycleNode = { id: "n1", kind: "phase", state: "active", label: "" };
    expect(renderNodeLine(node)).toBe("◆ n1 [phase] active");
  });
});

describe("renderLifecycleGraph", () => {
  it("renders dependency edges as 'from -> to' using labels", () => {
    expect(renderLifecycleGraph(model)).toContain("Deploy -> Build");
  });

  it("renders a placeholder when there are no edges", () => {
    const noEdges = replayEvents([{ type: "node-added", id: "a", kind: "phase" }]);
    expect(renderLifecycleGraph(noEdges)).toEqual(["(no dependencies)"]);
  });
});

describe("renderLifecycleSummary", () => {
  it("counts active/waiting/failed/terminal nodes and reports the revision", () => {
    const summary = renderLifecycleSummary(model);
    expect(summary).toContain("nodes 4");
    expect(summary).toContain("active 1");
    expect(summary).toContain("waiting 1");
    expect(summary).toContain("failed 0");
    expect(summary).toContain("terminal 1");
    expect(summary).toContain(`rev ${model.revision}`);
  });
});

describe("formatLifecycleView", () => {
  it("renders the header, timeline, and dependency graph", () => {
    const view = formatLifecycleView(model);
    expect(view[0]).toContain("Mission lifecycle (read-only)");
    expect(view).toContain("Timeline:");
    expect(view).toContain("Dependencies:");
    expect(view).toContain("  ◆ Ship [goal] active");
    expect(view).toContain("  Deploy -> Build");
  });

  it("is deterministic for the same projection", () => {
    expect(formatLifecycleView(model)).toEqual(formatLifecycleView(replayEvents(missionLog)));
  });
});

describe("renderLifecyclePanel (TUI render against a fixture projection)", () => {
  const style = shellStyle("none");

  it("renders the panel header, body, and footer for a fixture projection", () => {
    const lines = renderLifecyclePanel(20, 80, style, model);
    expect(lines.length).toBe(20);
    const joined = lines.join("\n");
    expect(joined).toContain("Mission lifecycle");
    expect(joined).toContain("read-only");
    expect(joined).toContain("◆ Ship [goal] active");
    expect(joined).toContain("Deploy -> Build");
    expect(joined).toContain("Esc close");
  });

  it("shows the empty placeholder when there is no mission activity", () => {
    const lines = renderLifecyclePanel(20, 80, style, emptyLifecycleModel());
    expect(lines.join("\n")).toContain("(no mission activity)");
  });

  it("returns no lines for a zero-height region", () => {
    expect(renderLifecyclePanel(0, 80, style, model)).toEqual([]);
  });
});
