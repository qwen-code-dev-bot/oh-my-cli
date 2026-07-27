import { describe, it, expect } from "vitest";
import {
  composeScreen,
  planRepaint,
  repaintSignature,
  createRenderStats,
} from "../../src/tui-shell.js";
import type { ShellState, TranscriptEntry, ComposedScreen } from "../../src/tui-shell.js";

const ROWS = 24;
const COLS = 80;

// A long prior history so the transcript is substantial; the active assistant
// turn is the last entry, grown incrementally to simulate streaming.
function longHistory(pairs: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < pairs; i++) {
    entries.push({ kind: "user", text: `Question number ${i + 1} about the codebase.` });
    entries.push({ kind: "assistant", text: `Answer number ${i + 1}: here is a thorough explanation.` });
  }
  return entries;
}

function stateWith(activeText: string, overrides: Partial<ShellState> = {}): ShellState {
  return {
    viewport: { rows: ROWS, cols: COLS },
    version: "0.1.0",
    transcript: [...longHistory(12), { kind: "assistant", text: activeText }],
    composer: { mode: "streaming", text: "", placeholder: "" },
    status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: "tokens 4096" },
    color: true,
    colorDepth: "256",
    turn: { phase: "streaming" },
    expanded: new Set<number>(),
    scroll: 0,
    hintsLearned: true,
    ...overrides,
  };
}

describe("planRepaint (#245)", () => {
  const screen = composeScreen(stateWith("hello"));

  it("forces a full repaint on the first paint (no previous screen)", () => {
    const plan = planRepaint(null, screen, { forceFull: false });
    expect(plan.full).toBe(true);
    expect(plan.cursorMoved).toBe(true);
  });

  it("forces a full repaint when explicitly requested", () => {
    const plan = planRepaint(screen, screen, { forceFull: true });
    expect(plan.full).toBe(true);
  });

  it("forces a full repaint when the row count changes (layout shifted)", () => {
    const shorter: ComposedScreen = { lines: screen.lines.slice(0, ROWS - 4), cursorRow: 0, cursorCol: 0 };
    const plan = planRepaint(shorter, screen, { forceFull: false });
    expect(plan.full).toBe(true);
  });

  it("reports only the differing rows for an incremental repaint", () => {
    const next: ComposedScreen = {
      lines: screen.lines.map((l, i) => (i === 5 ? l + "X" : l)),
      cursorRow: screen.cursorRow,
      cursorCol: screen.cursorCol,
    };
    const plan = planRepaint(screen, next, { forceFull: false });
    expect(plan.full).toBe(false);
    expect(plan.changedRows).toEqual([5]);
  });

  it("reports no changed rows when the screen is unchanged", () => {
    const plan = planRepaint(screen, screen, { forceFull: false });
    expect(plan.full).toBe(false);
    expect(plan.changedRows).toEqual([]);
    expect(plan.cursorMoved).toBe(false);
  });

  it("flags a cursor move even when no row changed", () => {
    const next: ComposedScreen = { ...screen, cursorCol: screen.cursorCol + 1 };
    const plan = planRepaint(screen, next, { forceFull: false });
    expect(plan.full).toBe(false);
    expect(plan.changedRows).toEqual([]);
    expect(plan.cursorMoved).toBe(true);
  });
});

describe("repaintSignature (#245)", () => {
  it("stays stable while only the streamed assistant text grows", () => {
    const a = repaintSignature(stateWith("x"));
    const b = repaintSignature(stateWith("x".repeat(30)));
    expect(b).toBe(a);
  });

  it("changes on resize, scroll, overlay, and color-mode changes", () => {
    const base = repaintSignature(stateWith("hello"));
    expect(repaintSignature(stateWith("hello", { viewport: { rows: 36, cols: 120 } }))).not.toBe(base);
    expect(repaintSignature(stateWith("hello", { scroll: 3 }))).not.toBe(base);
    expect(repaintSignature(stateWith("hello", { helpOpen: true }))).not.toBe(base);
    expect(repaintSignature(stateWith("hello", { color: false, colorDepth: "none" }))).not.toBe(base);
  });
});

describe("incremental repainting is canonical and bounded (#245)", () => {
  it("produces a byte-for-byte canonical screen after a stream of incremental repaints", () => {
    // Simulate the driver: a terminal buffer starts as the full composition, then
    // each streamed delta applies only the planned changed rows.
    let prev = composeScreen(stateWith("x"));
    const buffer = [...prev.lines];
    let signature = repaintSignature(stateWith("x"));

    for (let len = 2; len <= 30; len++) {
      const state = stateWith("x".repeat(len));
      const next = composeScreen(state);
      const plan = planRepaint(prev, next, { forceFull: repaintSignature(state) !== signature });
      expect(plan.full).toBe(false); // streaming keeps the structure stable
      for (const row of plan.changedRows) buffer[row] = next.lines[row];
      prev = next;
      signature = repaintSignature(state);
    }

    // The incrementally-maintained buffer equals a fresh full composition.
    expect(buffer).toEqual(composeScreen(stateWith("x".repeat(30))).lines);
  });

  it("bounds per-delta row writes regardless of transcript length", () => {
    // Grow the active turn one character at a time (within a single visible line)
    // over a long transcript history; each incremental repaint must touch only a
    // small bounded number of rows, never the whole visible screen.
    let prev = composeScreen(stateWith("x"));
    let signature = repaintSignature(stateWith("x"));
    const stats = createRenderStats();
    const deltas = 28;
    let maxChanged = 0;

    for (let len = 2; len <= deltas + 1; len++) {
      const state = stateWith("x".repeat(len));
      const next = composeScreen(state);
      const sig = repaintSignature(state);
      const plan = planRepaint(prev, next, { forceFull: sig !== signature });
      stats.composeCount++;
      if (plan.full) {
        stats.fullRepaints++;
        stats.rowsWritten += next.lines.length;
      } else {
        stats.incrementalRepaints++;
        stats.rowsWritten += plan.changedRows.length;
        maxChanged = Math.max(maxChanged, plan.changedRows.length);
      }
      prev = next;
      signature = sig;
    }

    // Every delta repainted incrementally (no full clears during streaming).
    expect(stats.fullRepaints).toBe(0);
    expect(stats.incrementalRepaints).toBe(deltas);
    // Each delta rewrote only a small bounded number of rows — far fewer than the
    // full visible screen a naive repaint would rewrite every time.
    expect(maxChanged).toBeLessThanOrEqual(6);
    expect(maxChanged).toBeLessThan(ROWS);
    // Total rows written grows with the number of deltas, not the transcript
    // length: bounded per-delta cost even with a long history above the fold.
    expect(stats.rowsWritten).toBeLessThanOrEqual(deltas * 6);
    expect(stats.rowsWritten).toBeLessThan(deltas * ROWS);
  });
});
