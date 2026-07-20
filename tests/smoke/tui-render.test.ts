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
import { buildSessionStats } from "../../src/session-stats.js";
import type { SessionStats } from "../../src/session-stats.js";
import type { SessionMessage } from "../../src/session.js";
import os from "node:os";
import {
  DEFAULT_LSP_SERVERS,
  applyLspEvent,
  discoverLanguageServers,
  formatLspView,
  startLspServer,
  stopLspServer,
} from "../../src/lsp-runtime.js";
import type { LspView } from "../../src/lsp-runtime.js";
import {
  cancelTask,
  createTaskSnapshot,
  formatTaskDetail,
  formatTaskView,
  recoverTask,
  registerTask,
  reconcileTasks,
  startTask,
  succeedTask,
  summarizeTasks,
  waitTask,
} from "../../src/task-runtime.js";
import type { TaskSnapshot, TaskView } from "../../src/task-runtime.js";

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

// The session-stats overlay (Issue #201, criterion 6): the E2E harness captures
// these renders inside a real tmux pane, publishing readable terminal evidence
// for navigation, populated and unavailable fields, a narrow layout, and parity
// with the machine-readable form — all from composeScreen, the exact pure path
// the live driver paints, fed by the same buildSessionStats engine that backs
// the headless `--session-stats` output.
describe("smoke: session stats overlay renders coherently (Issue #201)", () => {
  function statsTranscript(): SessionMessage[] {
    return [
      { role: "user", content: "investigate the failing build" },
      {
        role: "assistant",
        content: "looking into it",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "file contents", tool_call_id: "a" },
      { role: "tool", content: "matches", tool_call_id: "c" },
      { role: "assistant", content: "the build is fine now" },
    ];
  }

  // A populated live runtime: every model field is measured, and there is one
  // tool failure to summarize.
  function populatedStats(): SessionStats {
    return buildSessionStats({
      sessionId: "abc-123",
      messages: statsTranscript(),
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

  // No live runtime (a headless read or a freshly resumed session): model
  // activity, failures, and timing must read n/a, never a fabricated zero.
  function headlessStats(): SessionStats {
    return buildSessionStats({
      sessionId: "abc-123",
      messages: statsTranscript(),
      model: "fake-model",
      workspace: "~/proj",
    });
  }

  function statsState(
    rows: number,
    cols: number,
    stats: SessionStats,
    opts: { color: boolean; colorDepth?: "none" | "basic" | "256" } = {
      color: true,
      colorDepth: "256",
    },
  ): ShellState {
    return { ...stateFor(rows, cols, opts), stats };
  }

  function assertStatsCoherent(
    screen: { lines: string[] },
    rows: number,
    cols: number,
  ): void {
    expect(screen.lines).toHaveLength(rows);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("Session stats");
    expect(joined).toContain("read-only");
    expect(joined).toContain("Session activity");
    expect(joined).toContain("Model activity (this session)");
    expect(joined).toContain("Tool outcomes");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
    // The main transcript is not rendered while the overlay is open.
    expect(joined).not.toContain("src/layout.ts");
  }

  for (const { rows, cols } of SIZES) {
    it(`renders the stats overlay unclipped at ${rows}x${cols}`, () => {
      const screen = composeScreen(statsState(rows, cols, populatedStats()));
      assertStatsCoherent(screen, rows, cols);
      publish(`session stats ${rows}x${cols}`, screen.lines);
    });
  }

  it("surfaces tool calls and a failure summary by name at a full height", () => {
    // At a full height the whole body fits, so the per-name breakdowns are
    // visible (the smallest terminal truncates the body before these rows).
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(statsState(rows, cols, populatedStats()));
    assertStatsCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("read_file×2, grep×1");
    expect(joined).toContain("shell×1");
    publish(`session stats breakdown ${rows}x${cols}`, screen.lines);
  });

  it("renders unavailable model fields as n/a when there is no live runtime", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(statsState(rows, cols, headlessStats()));
    assertStatsCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    // No fabricated zeros: model activity, failures, and timing read n/a.
    expect(joined).toContain("n/a");
    expect(joined).not.toContain("shell×1"); // no runtime → no failure summary
    // Tool calls still come from the canonical log.
    expect(joined).toContain("read_file×2, grep×1");
    publish(`session stats n/a (no runtime) ${rows}x${cols}`, screen.lines);
  });

  it("renders the stats overlay within a narrow 24x80 terminal", () => {
    const { rows, cols } = { rows: 24, cols: 80 };
    const screen = composeScreen(statsState(rows, cols, populatedStats()));
    assertStatsCoherent(screen, rows, cols);
    publish(`session stats ${rows}x${cols} (narrow)`, screen.lines);
  });

  it("renders the stats overlay with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(
      statsState(rows, cols, populatedStats(), { color: false, colorDepth: "none" }),
    );
    assertStatsCoherent(screen, rows, cols);
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    publish(`session stats ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });

  it("shows the same numbers as the machine-readable JSON (parity)", () => {
    const stats = populatedStats();
    const screen = composeScreen(statsState(36, 120, stats));
    const joined = screen.lines.join("\n");
    // The pane and the headless JSON come from the same engine, so every
    // breakdown rendered in the overlay matches the JSON document field-for-field.
    for (const [name, count] of Object.entries(stats.tools.calls.byName)) {
      expect(joined).toContain(`${name}×${count}`);
    }
    expect(joined).toContain(String(stats.activity.messages));
    const json = JSON.parse(JSON.stringify(stats));
    expect(json.schema).toBe("oh-my-cli.stats");
    expect(json.tools.calls.byName).toEqual(stats.tools.calls.byName);
    expect(json.activity.messages).toBe(stats.activity.messages);
  });
});

// The language-server runtime + overlay (Issue #202). The E2E harness captures
// these renders and the printed runtime receipt inside a real tmux pane, so they
// publish the readable terminal evidence the issue asks for: a readiness
// transition, a real diagnostic, a stale-diagnostic rejection, and a clean
// shutdown — all from the same engine that backs the headless `--lsp-status`
// output and the interactive `/lsp` overlay (composeScreen, the exact pure path
// the live driver paints).
describe("smoke: language-server runtime receipt + overlay (Issue #202)", () => {
  const WS = "ws-202";
  const ROOT = `${os.homedir()}/project`;
  const FILE = `file://${ROOT}/src/a.ts`;

  function publishLine(line: string): void {
    process.stdout.write(`LSP E2E: ${line}\n`);
  }

  // A trusted workspace with one available server, one missing binary, and one
  // present-but-unsupported language — the explicit, quiet discovery surface.
  function trustedReport(): LspView["report"] {
    return discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: true,
      specs: DEFAULT_LSP_SERVERS,
      presentLanguages: ["cobol"],
      binaryAvailable: (cmd) => cmd === "typescript-language-server",
    });
  }

  function readyServer() {
    let server = startLspServer({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      sessionId: "session-202",
      language: "typescript",
      command: "typescript-language-server --stdio",
      now: 0,
    });
    server = applyLspEvent(server, { type: "ready", at: 10 }).server;
    return server;
  }

  it("drives a readiness transition, a real diagnostic, stale rejection, and clean shutdown", () => {
    let server = startLspServer({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      sessionId: "session-202",
      language: "typescript",
      command: "typescript-language-server --stdio",
      now: 0,
    });
    publishLine(`startup -> ${server.status} (instance ${server.instanceId})`);
    expect(server.status).toBe("starting");

    server = applyLspEvent(server, { type: "ready", at: 10 }).server;
    publishLine(`readiness transition starting -> ${server.status}`);
    expect(server.status).toBe("ready");

    const real = applyLspEvent(server, {
      type: "diagnostics",
      at: 20,
      workspaceKey: WS,
      instanceId: 1,
      fileUri: FILE,
      version: 1,
      items: [
        { severity: "error", message: "Cannot find name 'foo'", range: { startLine: 11, startChar: 4, endLine: 11, endChar: 7 } },
      ],
    });
    server = real.server;
    publishLine(
      `real diagnostic accepted v1: ${server.diagnostics[0].severity} ${server.diagnostics[0].displayUri} "${server.diagnostics[0].message}"`,
    );
    expect(real.accepted).toBe(true);
    expect(server.diagnostics).toHaveLength(1);

    const stale = applyLspEvent(server, {
      type: "diagnostics",
      at: 30,
      workspaceKey: WS,
      instanceId: 1,
      fileUri: FILE,
      version: 0,
      items: [{ severity: "warning", message: "superseded" }],
    });
    publishLine(
      `stale diagnostic v0 REJECTED (${stale.reason}); current stays v${server.diagnostics[0].version}`,
    );
    expect(stale.accepted).toBe(false);
    expect(server.diagnostics[0].version).toBe(1);

    const foreign = applyLspEvent(server, {
      type: "diagnostics",
      at: 35,
      workspaceKey: "another-workspace",
      instanceId: 1,
      fileUri: FILE,
      version: 2,
      items: [{ severity: "error", message: "foreign" }],
    });
    publishLine(`foreign-workspace diagnostic REJECTED (${foreign.reason})`);
    expect(foreign.accepted).toBe(false);

    server = stopLspServer(server, 40);
    publishLine(`clean shutdown -> ${server.status}; diagnostics cleared (${server.diagnostics.length} remain)`);
    expect(server.status).toBe("stopped");
    expect(server.diagnostics).toHaveLength(0);
  });

  function lspView(): LspView {
    return { report: trustedReport(), servers: [applyLspEvent(readyServer(), {
      type: "diagnostics",
      at: 20,
      workspaceKey: WS,
      instanceId: 1,
      fileUri: FILE,
      version: 1,
      items: [
        { severity: "error", message: "Cannot find name 'foo'", range: { startLine: 11, startChar: 4, endLine: 11, endChar: 7 } },
        { severity: "warning", message: "'bar' is declared but its value is never read", range: { startLine: 3, startChar: 6, endLine: 3, endChar: 9 } },
      ],
    }).server] };
  }

  function lspState(rows: number, cols: number, view: LspView, opts: { color: boolean; colorDepth?: "none" | "basic" | "256" } = { color: true, colorDepth: "256" }): ShellState {
    return { ...stateFor(rows, cols, opts), lsp: view };
  }

  function assertLspCoherent(screen: { lines: string[] }, rows: number, cols: number): void {
    expect(screen.lines).toHaveLength(rows);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    const joined = screen.lines.join("\n");
    // The header is always present; deeper body rows (the configured-server list
    // and active-server detail) truncate at the smallest terminal, so they are
    // asserted only at a full height below.
    expect(joined).toContain("Language servers");
    expect(joined).toContain("read-only");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
    // The main transcript is not rendered while the overlay is open.
    expect(joined).not.toContain("src/layout.ts");
  }

  for (const { rows, cols } of SIZES) {
    it(`renders the language-server overlay unclipped at ${rows}x${cols}`, () => {
      const screen = composeScreen(lspState(rows, cols, lspView()));
      assertLspCoherent(screen, rows, cols);
      publish(`language servers ${rows}x${cols}`, screen.lines);
    });
  }

  it("surfaces discovery, readiness, and a workspace-bound diagnostic at a full height", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(lspState(rows, cols, lspView()));
    assertLspCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    // Both sections of the inspectable view are present at a full height.
    expect(joined).toContain("Configured servers");
    expect(joined).toContain("Active servers");
    // Discovery: available, missing-binary, and unsupported are all explicit.
    expect(joined).toContain("typescript  available");
    expect(joined).toContain("python  missing-binary");
    expect(joined).toContain("cobol  unsupported");
    // Readiness + a workspace-bound diagnostic with its version.
    expect(joined).toContain("typescript  ready  (instance 1)");
    expect(joined).toContain("Cannot find name 'foo'");
    expect(joined).toContain("v1");
    publish(`language servers detail ${rows}x${cols}`, screen.lines);
    // Publish the full inspectable view too, as the readable receipt.
    publish("language servers view (formatLspView)", formatLspView(lspView()));
  });

  it("renders an untrusted workspace with no running servers (quiet, explicit)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const report = discoverLanguageServers({
      workspaceKey: WS,
      workspaceRoot: ROOT,
      trusted: false,
      specs: DEFAULT_LSP_SERVERS,
      binaryAvailable: () => true,
    });
    const screen = composeScreen(lspState(rows, cols, { report, servers: [] }));
    assertLspCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("untrusted (servers not started)");
    expect(joined).toContain("none running");
    publish(`language servers untrusted ${rows}x${cols}`, screen.lines);
  });

  it("renders the language-server overlay with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const screen = composeScreen(lspState(rows, cols, lspView(), { color: false, colorDepth: "none" }));
    assertLspCoherent(screen, rows, cols);
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    publish(`language servers ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});

// Background-task center (Issue #203): a real terminal/tmux E2E receipt that
// drives the deterministic engine through concurrent foreground use, live
// updates, inspect, idempotent+scoped cancel, and restart recovery (orphan then
// recover), plus the read-only `/tasks` overlay (composeScreen, the exact pure
// path the live driver paints).
describe("smoke: background-task center receipt + overlay (Issue #203)", () => {
  const WS = `${os.homedir()}/project/.git`;
  const ROOT = `${os.homedir()}/project`;

  function publishLine(line: string): void {
    process.stdout.write(`TASK E2E: ${line}\n`);
  }

  function state(s: TaskSnapshot): { [id: string]: string } {
    const out: { [id: string]: string } = {};
    for (const t of s.tasks) out[t.id] = t.state;
    return out;
  }

  it("drives concurrent tasks, live updates, inspect, cancel, and restart recovery", () => {
    let s = createTaskSnapshot({ sessionId: "session-203", workspaceKey: WS, maxConcurrent: 2 });
    const a = registerTask(s, { type: "verify", label: "verify build", owner: "session-203" }, 0);
    s = a.snapshot;
    const b = registerTask(s, { type: "shell", label: "e2e capture", owner: "session-203" }, 1);
    s = b.snapshot;
    publishLine(`registered ${a.task!.id} + ${b.task!.id} (queued behind a maxConcurrent=2 limit)`);

    // Concurrent foreground use: both run while the conversation stays usable.
    s = startTask(s, a.task!.id, 4200, 10).snapshot;
    s = startTask(s, b.task!.id, 4201, 11).snapshot;
    publishLine(
      `concurrent foreground use: ${a.task!.id} running (pid 4200), ${b.task!.id} running (pid 4201)`,
    );
    expect(state(s)[a.task!.id]).toBe("running");
    expect(state(s)[b.task!.id]).toBe("running");

    // Live update: one succeeds with a durable receipt.
    s = succeedTask(s, a.task!.id, { digest: "verify-digest", evidenceLink: `file://${ROOT}/e2e/verify.json` }, 20).snapshot;
    publishLine(`live update: ${a.task!.id} -> succeeded with a durable receipt`);
    expect(state(s)[a.task!.id]).toBe("succeeded");

    // Inspect: the durable receipt is visible in the detail view.
    const detail = formatTaskDetail(s.tasks.find((t) => t.id === a.task!.id)!);
    publishLine(`inspect ${a.task!.id}: ${detail[0]} | receipt visible`);
    expect(detail.join("\n")).toContain("receipt:");
    expect(detail.join("\n")).toContain(`file://~/project/e2e/verify.json`);

    // Cancel: idempotent and scoped — the second cancel is a no-op, the sibling
    // is untouched.
    const c1 = cancelTask(s, b.task!.id, 30);
    s = c1.snapshot;
    const c2 = cancelTask(s, b.task!.id, 31);
    publishLine(
      `cancel ${b.task!.id}: cancelled=${c1.alreadyTerminal === false}, second cancel no-op=${c2.alreadyTerminal === true}`,
    );
    expect(c1.alreadyTerminal).toBe(false);
    expect(c2.alreadyTerminal).toBe(true);
    expect(state(s)[a.task!.id]).toBe("succeeded");

    // Restart recovery: a running task's process is gone with no receipt ->
    // orphaned (NOT complete); a durable receipt then surfaces -> recovered.
    const r = registerTask(s, { type: "shell", label: "long job", owner: "session-203" }, 40);
    s = r.snapshot;
    s = startTask(s, r.task!.id, 4300, 41).snapshot;
    s = reconcileTasks(s, { isAlive: () => false }, 50).snapshot;
    publishLine(
      `restart recovery: ${r.task!.id} process gone, no receipt -> ${state(s)[r.task!.id]} (never marked complete)`,
    );
    expect(state(s)[r.task!.id]).toBe("orphaned");
    s = recoverTask(s, r.task!.id, { digest: "recovered-digest" }, 60).snapshot;
    publishLine(`restart recovery: ${r.task!.id} durable receipt found -> ${state(s)[r.task!.id]}`);
    expect(state(s)[r.task!.id]).toBe("recovered");
  });

  // A rich, deterministic view for the render captures: one running (with
  // progress), one waiting on approval, one succeeded, one cancelled.
  function taskView(): TaskView {
    let s = createTaskSnapshot({ sessionId: "session-203", workspaceKey: WS, maxConcurrent: 2 });
    s = registerTask(s, { type: "verify", label: "verify build" }, 0).snapshot;
    s = registerTask(s, { type: "shell", label: "e2e capture" }, 1).snapshot;
    s = registerTask(s, { type: "subagent", label: "explore repo" }, 2).snapshot;
    s = registerTask(s, { type: "shell", label: "stale job" }, 3).snapshot;
    const ids = s.tasks.map((t) => t.id);
    s = startTask(s, ids[0], 4200, 10).snapshot;
    s = startTask(s, ids[1], 4201, 11).snapshot;
    // Free a slot (waiting is not running) so the next two can start under the
    // maxConcurrent=2 limit.
    s = waitTask(s, ids[1], "approval required", 12).snapshot;
    s = startTask(s, ids[2], 4203, 13).snapshot;
    s = succeedTask(s, ids[2], { digest: "explore-digest" }, 20).snapshot;
    s = startTask(s, ids[3], 4202, 21).snapshot;
    s = cancelTask(s, ids[3], 30).snapshot;
    // Attach a bounded progress hint to the running task for display.
    s = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === ids[0] ? { ...t, progress: { text: "3/7 steps" } } : t)),
    };
    return { summary: summarizeTasks(s), workspaceRoot: ROOT };
  }

  function taskState(
    rows: number,
    cols: number,
    view: TaskView,
    opts: { color: boolean; colorDepth?: "none" | "basic" | "256" } = { color: true, colorDepth: "256" },
  ): ShellState {
    return { ...stateFor(rows, cols, opts), tasks: view };
  }

  function assertTaskCoherent(screen: { lines: string[] }, rows: number, cols: number): void {
    expect(screen.lines).toHaveLength(rows);
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    const joined = screen.lines.join("\n");
    // The header is always present; deeper body rows truncate at the smallest
    // terminal, so they are asserted only at a full height below.
    expect(joined).toContain("Background tasks");
    expect(joined).toContain("read-only");
    // The status footer stays anchored below the overlay.
    expect(joined).toContain("approval default");
    // The main transcript is not rendered while the overlay is open.
    expect(joined).not.toContain("src/layout.ts");
  }

  for (const { rows, cols } of SIZES) {
    it(`renders the background-task overlay unclipped at ${rows}x${cols}`, () => {
      const screen = composeScreen(taskState(rows, cols, taskView()));
      assertTaskCoherent(screen, rows, cols);
      publish(`background tasks ${rows}x${cols}`, screen.lines);
    });
  }

  it("surfaces states, durable receipts, and restart recovery at a full height", () => {
    const { rows, cols } = { rows: 48, cols: 160 };
    const view = taskView();
    const screen = composeScreen(taskState(rows, cols, view));
    assertTaskCoherent(screen, rows, cols);
    const joined = screen.lines.join("\n");
    // Compact summary plus the inspectable detail section.
    expect(joined).toContain("summary:");
    expect(joined).toContain("detail");
    // The lifecycle states are explicit in the panel.
    expect(joined).toContain("running");
    expect(joined).toContain("waiting");
    expect(joined).toContain("succeeded");
    expect(joined).toContain("cancelled");
    // Bounded progress hint for the running task.
    expect(joined).toContain("3/7 steps");
    // The full inspectable view (unclipped) carries the durable receipts; the
    // panel clips deep detail, so assert receipts against the readable form.
    const full = formatTaskView(view).join("\n");
    expect(full).toContain("receipt:");
    expect(full).toContain("explore-digest".slice(0, 12));
    publish(`background tasks detail ${rows}x${cols}`, screen.lines);
    publish("background tasks view (formatTaskView)", formatTaskView(view));
  });

  it("renders an honest empty task center when a session has no background tasks", () => {
    const { rows, cols } = { rows: 36, cols: 120 };
    const empty: TaskView = { summary: summarizeTasks(createTaskSnapshot({ sessionId: "s", workspaceKey: WS })), workspaceRoot: ROOT };
    const screen = composeScreen(taskState(rows, cols, empty));
    assertTaskCoherent(screen, rows, cols);
    expect(screen.lines.join("\n")).toContain("no background tasks.");
    publish(`background tasks empty ${rows}x${cols}`, screen.lines);
  });

  it("renders the background-task overlay with no color (text + structure only)", () => {
    const { rows, cols } = { rows: 40, cols: 120 };
    const screen = composeScreen(taskState(rows, cols, taskView(), { color: false, colorDepth: "none" }));
    assertTaskCoherent(screen, rows, cols);
    expect(screen.lines.join("")).not.toMatch(/\x1b\[/);
    publish(`background tasks ${rows}x${cols} (NO_COLOR)`, screen.lines);
  });
});
