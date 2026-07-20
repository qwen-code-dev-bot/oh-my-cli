import { describe, it, expect } from "vitest";
import {
  renderStatsPanel,
  shellStyle,
  composeScreen,
  visibleWidth,
} from "../../src/tui-shell.js";
import type { ShellState } from "../../src/tui-shell.js";
import { buildSessionStats } from "../../src/session-stats.js";
import type { SessionStats } from "../../src/session-stats.js";
import type { SessionMessage } from "../../src/session.js";

const style = shellStyle(false);

function richStats(): SessionStats {
  const messages: SessionMessage[] = [
    { role: "user", content: "investigate the failing build" },
    {
      role: "assistant",
      content: "looking",
      tool_calls: [
        { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    },
    { role: "assistant", content: "the build is fine now" },
  ];
  return buildSessionStats({
    sessionId: "abc-123",
    messages,
    model: "fake-model",
    workspace: "~/proj",
    runtime: {
      rounds: 3,
      retries: 1,
      elapsedMs: 8400,
      tokens: { prompt: 500, completion: 80, total: 580 },
      estimatedCostUsd: 0.0015,
      costKnown: true,
      toolFailures: { shell: 1 },
    },
  });
}

describe("renderStatsPanel", () => {
  it("shows the title, sections, values, and dismiss hint", () => {
    const lines = renderStatsPanel(24, 80, style, richStats());
    const joined = lines.join("\n");
    expect(joined).toContain("Session stats");
    expect(joined).toContain("read-only");
    expect(joined).toContain("Session activity");
    expect(joined).toContain("Model activity (this session)");
    expect(joined).toContain("Tool outcomes");
    // read_file and grep are tied at one call each, so they sort alphabetically.
    expect(joined).toContain("grep×1, read_file×1");
    expect(joined).toContain("Esc close");
  });

  it("fills exactly the given height and never overflows the width", () => {
    const lines = renderStatsPanel(20, 60, style, richStats());
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("stays coherent on a narrow terminal", () => {
    const lines = renderStatsPanel(16, 24, style, richStats());
    expect(lines).toHaveLength(16);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    // The title survives even when narrow.
    expect(lines.join("\n")).toContain("Session stats");
  });

  it("keeps the title and rule when the region is too short for the body", () => {
    const lines = renderStatsPanel(2, 80, style, richStats());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Session stats");
  });

  it("returns nothing for a zero-height region", () => {
    expect(renderStatsPanel(0, 80, style, richStats())).toEqual([]);
  });
});

describe("composeScreen with a stats overlay", () => {
  function baseState(): ShellState {
    return {
      viewport: { rows: 24, cols: 80 },
      version: "0.1.0",
      transcript: [
        { kind: "user", text: "do the long task" },
        { kind: "assistant", text: "working on it" },
      ],
      composer: { mode: "focused", text: "", placeholder: "Ask a question, or type / for commands" },
      status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: null },
      color: false,
      turn: { phase: "idle" },
      expanded: new Set(),
      scroll: 0,
    };
  }

  it("renders the stats over the main area while keeping the status anchored", () => {
    const state: ShellState = { ...baseState(), stats: richStats() };
    const screen = composeScreen(state);
    expect(screen.lines).toHaveLength(24);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("Session stats");
    expect(joined).toContain("Session activity");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
    // The main transcript body is not rendered while the overlay is open.
    expect(joined).not.toContain("working on it");
  });

  it("lets an active side question take precedence over the stats overlay", () => {
    const state: ShellState = {
      ...baseState(),
      stats: richStats(),
      sideQuestion: {
        question: "quick one?",
        phase: "answered",
        contextSummary: "Context (read-only).",
        providerActive: false,
        answer: "here",
      },
    };
    const joined = composeScreen(state).lines.join("\n");
    expect(joined).toContain("Side question");
    expect(joined).not.toContain("Session stats");
  });
});
