import { describe, it, expect } from "vitest";
import {
  activityGlyph,
  formatElapsed,
  livenessMarker,
  renderActivityCard,
  renderActivityStream,
  formatActivityView,
  initialActivityViewState,
  toggleExpand,
  toggleExpandAll,
  setFollowMode,
  markRead,
  bumpUnread,
} from "../../src/activity-render.js";
import type { PresentedEvent } from "../../src/event-presentation.js";
import { renderActivityPanel, shellStyle } from "../../src/tui-shell.js";

function event(overrides: Partial<PresentedEvent> = {}): PresentedEvent {
  return {
    kind: "tool-call",
    status: "active",
    summary: "running rg",
    detail: "line1\nline2",
    detailTruncated: false,
    elapsedMs: 1500,
    live: true,
    ...overrides,
  };
}

describe("activity glyphs / elapsed / liveness", () => {
  it("maps each status to a stable glyph", () => {
    expect(activityGlyph("pending")).toBe("○");
    expect(activityGlyph("active")).toBe("◆");
    expect(activityGlyph("completed")).toBe("✓");
    expect(activityGlyph("failed")).toBe("✕");
    expect(activityGlyph("waiting")).toBe("◇");
    expect(activityGlyph("cancelled")).toBe("⊘");
  });

  it("formats elapsed time as s/m/h", () => {
    expect(formatElapsed(1500)).toBe("1s");
    expect(formatElapsed(90_000)).toBe("1m");
    expect(formatElapsed(7_200_000)).toBe("2h");
  });

  it("marks liveness", () => {
    expect(livenessMarker(true)).toBe("●");
    expect(livenessMarker(false)).toBe("·");
  });
});

describe("renderActivityCard: progressive disclosure", () => {
  it("renders a single summary line when collapsed", () => {
    const lines = renderActivityCard(event(), false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("◆ tool-call");
    expect(lines[0]).toContain("running rg");
    expect(lines[0]).toContain("1s");
    expect(lines[0]).toContain("●");
    expect(lines[0]).toContain("active");
  });

  it("reveals bounded detail when expanded", () => {
    const lines = renderActivityCard(event(), true);
    expect(lines[0]).toContain("running rg");
    expect(lines).toContain("  line1");
    expect(lines).toContain("  line2");
  });

  it("notes truncation when the detail was bounded", () => {
    const lines = renderActivityCard(event({ detailTruncated: true }), true);
    expect(lines).toContain("  … (detail truncated)");
  });

  it("shows a placeholder for empty detail when expanded", () => {
    const lines = renderActivityCard(event({ detail: "" }), true);
    expect(lines).toContain("  (no detail)");
  });
});

describe("renderActivityStream / formatActivityView", () => {
  it("renders a placeholder for an empty stream", () => {
    expect(renderActivityStream([], initialActivityViewState())).toEqual(["(no activity)"]);
  });

  it("renders one card per event, expanding only the expanded indices", () => {
    const events = [event({ summary: "first" }), event({ summary: "second" })];
    const state = toggleExpand(initialActivityViewState(), 1);
    const lines = renderActivityStream(events, state);
    expect(lines.some((l) => l.includes("first"))).toBe(true);
    // The expanded second card reveals its detail; the collapsed first does not.
    expect(lines.filter((l) => l.includes("line1")).length).toBe(1);
  });

  it("renders the view header with counts, follow-mode, and unread", () => {
    const events = [event({ live: true }), event({ live: false, status: "completed" })];
    const view = formatActivityView(events, initialActivityViewState());
    expect(view[0]).toContain("events 2");
    expect(view[0]).toContain("live 1");
    expect(view[0]).toContain("follow on");
    expect(view[0]).toContain("unread 0");
  });
});

describe("activity view-state transitions", () => {
  it("starts with no expansion, follow-mode on, zero unread", () => {
    const state = initialActivityViewState();
    expect(state.expanded.size).toBe(0);
    expect(state.followMode).toBe(true);
    expect(state.unread).toBe(0);
  });

  it("toggleExpand adds and removes an index without mutating the input", () => {
    const s0 = initialActivityViewState();
    const s1 = toggleExpand(s0, 2);
    expect(s1.expanded.has(2)).toBe(true);
    expect(s0.expanded.has(2)).toBe(false);
    const s2 = toggleExpand(s1, 2);
    expect(s2.expanded.has(2)).toBe(false);
  });

  it("toggleExpandAll expands all then collapses all", () => {
    const s0 = initialActivityViewState();
    const expanded = toggleExpandAll(s0, 3);
    expect(expanded.expanded.size).toBe(3);
    const collapsed = toggleExpandAll(expanded, 3);
    expect(collapsed.expanded.size).toBe(0);
  });

  it("setFollowMode / markRead / bumpUnread behave purely", () => {
    const s0 = initialActivityViewState();
    expect(setFollowMode(s0, false).followMode).toBe(false);
    expect(bumpUnread(s0, 4).unread).toBe(4);
    expect(markRead(bumpUnread(s0, 4)).unread).toBe(0);
    expect(s0.unread).toBe(0); // input unchanged
  });
});

describe("renderActivityPanel (TUI render against fixture events)", () => {
  const style = shellStyle("none");

  it("renders the panel header, cards, and footer gestures", () => {
    const overlay = { events: [event({ summary: "running rg" })], view: initialActivityViewState() };
    const lines = renderActivityPanel(12, 60, style, overlay);
    expect(lines.length).toBe(12);
    const joined = lines.join("\n");
    expect(joined).toContain("Activity");
    expect(joined).toContain("read-only");
    expect(joined).toContain("running rg");
    expect(joined).toContain("e expand/collapse · f follow · Esc close");
  });

  it("shows the empty placeholder for an empty stream", () => {
    const overlay = { events: [], view: initialActivityViewState() };
    expect(renderActivityPanel(10, 60, style, overlay).join("\n")).toContain("(no activity)");
  });

  it("returns no lines for a zero-height region", () => {
    const overlay = { events: [event()], view: initialActivityViewState() };
    expect(renderActivityPanel(0, 60, style, overlay)).toEqual([]);
  });
});
