import { describe, it, expect } from "vitest";
import {
  composeScreen,
  makeToolOperation,
  deriveFileDiff,
  deriveFailure,
  visibleWidth,
} from "../../src/tui-shell.js";
import type {
  ShellState,
  TranscriptEntry,
  ReferencePreviewState,
  SideQuestionState,
} from "../../src/tui-shell.js";

// Renders the full-screen shell at the three target terminal dimensions and a
// reduced-color (basic 16-color) mode plus NO_COLOR, asserting each capture is
// coherent: the exact row count, no horizontal overflow, and the primary state
// (active turn, a diff, a recoverable failure, the status footer) visible. The
// E2E evidence harness runs this suite inside a real tmux pane and captures it,
// so the printed captures publish the readable terminal evidence the issue asks
// for across all three dimensions plus a reduced-color interaction (Issue #164,
// criterion 7). The renders come from composeScreen — the exact pure path the
// live driver paints — so the captures are faithful to the shipped shell.

function richTranscript(): TranscriptEntry[] {
  const edit = makeToolOperation({
    name: "edit",
    state: "succeeded",
    turnId: 1,
    output: "Edited src/layout.ts (single occurrence replaced).",
    durationMs: 12,
  });
  edit.diff = deriveFileDiff("edit", {
    path: "src/layout.ts",
    oldText: "const rows = 24;",
    newText: "const rows = clampRows(24);",
  });
  const fail = makeToolOperation({
    name: "shell",
    state: "failed",
    turnId: 1,
    output: "npm error: command not found: tscx",
  });
  fail.failure = deriveFailure("shell", { command: "tscx" }, { content: "npm error: command not found: tscx", isError: true });
  return [
    { kind: "user", text: "Make the layout coherent across terminal sizes and color modes." },
    { kind: "assistant", text: "Done: the shell now adapts its regions and palette while keeping every state textual." },
    { kind: "tool", text: "", tool: edit },
    { kind: "error", text: "", tool: fail },
  ];
}

function stateFor(
  rows: number,
  cols: number,
  opts: { color: boolean; colorDepth?: "none" | "basic" | "256" },
): ShellState {
  return {
    viewport: { rows, cols },
    version: "0.1.0",
    transcript: richTranscript(),
    composer: {
      mode: "focused",
      text: "",
      placeholder: "Ask a question, or type / for commands",
    },
    status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: "tokens 4096" },
    color: opts.color,
    colorDepth: opts.colorDepth,
    turn: { phase: "completed" },
    expanded: new Set([2]),
    scroll: 0,
    hintsLearned: false,
  };
}

const SIZES = [
  { rows: 24, cols: 80 },
  { rows: 36, cols: 120 },
  { rows: 48, cols: 160 },
];

function assertCoherent(screen: { lines: string[] }, rows: number, cols: number): void {
  expect(screen.lines).toHaveLength(rows);
  for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  const joined = screen.lines.join("\n");
  expect(joined).toContain("src/layout.ts"); // diff magnitude in context
  expect(joined).toContain("completed"); // active-turn outcome, rendered in place
  expect(joined).toContain("approval default"); // status footer
}

function publish(title: string, lines: string[]): void {
  // Printed to stdout so the E2E tmux capture publishes a readable screen.
  process.stdout.write(`\n===== ${title} =====\n`);
  process.stdout.write(lines.join("\n") + "\n");
}

describe("smoke: shell renders coherently across sizes and color modes (Issue #164, criterion 7)", () => {
  for (const { rows, cols } of SIZES) {
    it(`renders a readable, unclipped screen at ${rows}x${cols} (256-color)`, () => {
      const screen = composeScreen(stateFor(rows, cols, { color: true, colorDepth: "256" }));
      assertCoherent(screen, rows, cols);
      publish(`${rows}x${cols} (256-color)`, screen.lines);
    });
  }

  it("renders a readable reduced-color (basic 16-color) screen", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(stateFor(rows, cols, { color: true, colorDepth: "basic" }));
    assertCoherent(screen, rows, cols);
    // Basic palette only: never the indexed 256-color form a reduced terminal can't map.
    expect(screen.lines.join("")).not.toContain("38;5");
    publish(`${rows}x${cols} (reduced-color / basic)`, screen.lines);
  });

  it("renders a readable NO_COLOR screen (every state via text + structure)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(stateFor(rows, cols, { color: false, colorDepth: "none" }));
    assertCoherent(screen, rows, cols);
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    publish(`${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});

describe("smoke: keyboard-shortcut help panel renders coherently (Issue #169)", () => {
  function helpState(
    rows: number,
    cols: number,
    opts: { color: boolean; colorDepth?: "none" | "basic" | "256" },
  ): ShellState {
    return { ...stateFor(rows, cols, opts), helpOpen: true };
  }

  for (const { rows, cols } of SIZES) {
    it(`renders the help panel unclipped at ${rows}x${cols}`, () => {
      const screen = composeScreen(helpState(rows, cols, { color: true, colorDepth: "256" }));
      expect(screen.lines).toHaveLength(rows);
      for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      const joined = screen.lines.join("\n");
      expect(joined).toContain("Keyboard shortcuts");
      expect(joined).toContain("Open the command palette"); // Ctrl+K binding advertised
      expect(joined).toContain("approval default"); // status footer stays anchored
      publish(`help ${rows}x${cols}`, screen.lines);
    });
  }

  it("renders the help panel with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(helpState(rows, cols, { color: false, colorDepth: "none" }));
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    expect(screen.lines.join("\n")).toContain("Keyboard shortcuts");
    publish(`help ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});

// The composer `@` reference picker (Issue #196, criterion 6): the E2E harness
// captures these renders inside a real tmux pane, so they publish the readable
// terminal evidence for keyboard selection, insertion hints, cancellation/
// refusal states, and a narrow layout — all from composeScreen, the exact pure
// path the live driver paints.
describe("smoke: workspace reference picker renders coherently (Issue #196)", () => {
  function referencePreview(
    overrides: Partial<ReferencePreviewState> = {},
  ): ReferencePreviewState {
    return {
      candidates: [
        { path: "src/tui-shell.ts", type: "file", sizeBytes: 98_304, score: 12 },
        { path: "src/workspace-reference.ts", type: "file", sizeBytes: 18_432, score: 9 },
        { path: "src/workspace.ts", type: "file", sizeBytes: 6_144, score: 7 },
        { path: "src", type: "directory", sizeBytes: 0, score: 5 },
        { path: "tests/unit/workspace-reference.test.ts", type: "file", sizeBytes: 12_288, score: 4 },
        { path: "docs/architecture.md", type: "file", sizeBytes: 3_072, score: 3 },
      ],
      selected: 0,
      query: "src",
      total: 6,
      truncated: false,
      state: "ok",
      excluded: { binary: 2, secret: 1, ignored: 4 },
      ...overrides,
    };
  }

  function referenceState(
    rows: number,
    cols: number,
    preview: ReferencePreviewState,
    opts: { color: boolean; colorDepth?: "none" | "basic" | "256" } = {
      color: true,
      colorDepth: "256",
    },
  ): ShellState {
    return {
      ...stateFor(rows, cols, opts),
      composer: { mode: "focused", text: "look at @src", placeholder: "" },
      referencePreview: preview,
    };
  }

  function assertPickerCoherent(
    screen: { lines: string[] },
    rows: number,
    cols: number,
  ): void {
    expect(screen.lines).toHaveLength(rows);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }

  // Drop SGR color codes so cross-boundary content (a color reset can sit
  // between a path and its meta label) can be asserted as plain text.
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("renders the candidate list with a highlighted selection and insertion hints", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(referenceState(rows, cols, referencePreview()));
    assertPickerCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("FILES 1/6"); // position + total
    expect(joined).toContain("Tab insert"); // insertion hint
    expect(joined).toContain("src/tui-shell.ts"); // highlighted candidate
    expect(joined).toContain("◆"); // selection marker
    expect(joined).toContain("file 96 KB"); // file type + size
    // The directory row carries a single "dir" label, never a redundant size.
    expect(stripAnsi(joined)).toContain("src  dir");
    expect(joined).not.toContain("dir dir");
    // The bounded window shows at most REFERENCE_PREVIEW_MAX_ITEMS rows, so the
    // sixth candidate is scrolled out of view at the top selection.
    expect(joined).not.toContain("docs/architecture.md");
    publish(`reference picker ${rows}x${cols}`, screen.lines);
  });

  it("renders the picker within a narrow 24x80 terminal", () => {
    const { rows, cols } = { rows: 24, cols: 80 };
    const screen = composeScreen(referenceState(rows, cols, referencePreview({ selected: 2 })));
    assertPickerCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("FILES 3/6"); // selection moved down
    expect(joined).toContain("src/workspace.ts"); // highlighted candidate
    publish(`reference picker ${rows}x${cols} (narrow)`, screen.lines);
  });

  it("renders an explicit untrusted refusal without candidates", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(
      referenceState(
        rows,
        cols,
        referencePreview({ candidates: [], state: "untrusted", total: 0, query: "" }),
      ),
    );
    assertPickerCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("Workspace not trusted");
    expect(joined).not.toContain("src/tui-shell.ts");
    publish(`reference picker untrusted ${rows}x${cols}`, screen.lines);
  });

  it("renders an explicit no-match state", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(
      referenceState(
        rows,
        cols,
        referencePreview({ candidates: [], state: "no-match", total: 0, query: "zzz-nope" }),
      ),
    );
    assertPickerCoherent(screen, rows, cols);
    expect(screen.lines.join("\n")).toContain("No files match");
    publish(`reference picker no-match ${rows}x${cols}`, screen.lines);
  });

  it("renders the picker with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(
      referenceState(rows, cols, referencePreview(), { color: false, colorDepth: "none" }),
    );
    assertPickerCoherent(screen, rows, cols);
    const flat = screen.lines.join("");
    expect(flat).not.toMatch(/\x1b\[/);
    expect(screen.lines.join("\n")).toContain("src/tui-shell.ts");
    publish(`reference picker ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});

// The side-question overlay (Issue #200, criterion 6): the E2E harness captures
// these renders inside a real tmux pane, publishing readable terminal evidence
// for opening, streaming, cancellation, dismissal, and main-task continuity —
// all from composeScreen, the exact pure path the live driver paints.
describe("smoke: side-question overlay renders coherently (Issue #200)", () => {
  const SUMMARY =
    "Context (read-only): last 4 of 12 messages. Tools and workspace changes are disabled; the main task is unaffected.";

  function sideState(
    rows: number,
    cols: number,
    sq: SideQuestionState,
    opts: { color: boolean; colorDepth?: "none" | "basic" | "256" } = {
      color: true,
      colorDepth: "256",
    },
  ): ShellState {
    return { ...stateFor(rows, cols, opts), sideQuestion: sq };
  }

  function assertSideCoherent(
    screen: { lines: string[] },
    rows: number,
    cols: number,
  ): void {
    expect(screen.lines).toHaveLength(rows);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    const joined = screen.lines.join("\n");
    // The overlay states the boundary and that the main task is unaffected.
    expect(joined).toContain("Side question");
    expect(joined).toContain("read-only");
    expect(joined).toContain("main task unaffected");
    // The main transcript is not rendered while the overlay is open.
    expect(joined).not.toContain("src/layout.ts");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
  }

  const answered: SideQuestionState = {
    question: "Which test runner does this project use?",
    phase: "answered",
    contextSummary: SUMMARY,
    providerActive: false,
    answer: "This project uses vitest for unit and integration tests, run via npm test.",
  };

  for (const { rows, cols } of SIZES) {
    it(`renders an answered side question unclipped at ${rows}x${cols}`, () => {
      const screen = composeScreen(sideState(rows, cols, answered));
      assertSideCoherent(screen, rows, cols);
      const joined = screen.lines.join("\n");
      expect(joined).toContain("Which test runner does this project use?");
      expect(joined).toContain("vitest");
      expect(joined).toContain("Provider request: none · answered");
      expect(joined).toContain("Enter promote to composer");
      publish(`side question ${rows}x${cols}`, screen.lines);
    });
  }

  it("renders a streaming side question with an active provider request", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const streaming: SideQuestionState = {
      question: "why is the build failing?",
      phase: "streaming",
      contextSummary: SUMMARY,
      providerActive: true,
      answer: "The build is failing because",
    };
    const screen = composeScreen(sideState(rows, cols, streaming));
    assertSideCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("Provider request: active · streaming");
    expect(joined).toContain("Esc cancel");
    publish(`side question streaming ${rows}x${cols}`, screen.lines);
  });

  it("renders a cancelled side question recoverably", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const cancelled: SideQuestionState = {
      question: "long-running clarification?",
      phase: "cancelled",
      contextSummary: SUMMARY,
      providerActive: false,
      answer: "partial ans",
    };
    const screen = composeScreen(sideState(rows, cols, cancelled));
    assertSideCoherent(screen, rows, cols);
    expect(screen.lines.join("\n")).toContain("cancelled");
    expect(screen.lines.join("\n")).toContain("Esc dismiss");
    publish(`side question cancelled ${rows}x${cols}`, screen.lines);
  });

  it("renders the side question with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(
      sideState(rows, cols, answered, { color: false, colorDepth: "none" }),
    );
    assertSideCoherent(screen, rows, cols);
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    publish(`side question ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});
