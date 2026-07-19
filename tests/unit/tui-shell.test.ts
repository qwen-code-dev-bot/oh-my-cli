import { describe, it, expect } from "vitest";
import {
  computeLayout,
  composerTotalRows,
  composerMarker,
  renderComposer,
  renderStatusLine,
  renderTranscript,
  flattenTranscript,
  composeScreen,
  renderShell,
  shellStyle,
  isFullScreenCapable,
  wrapLine,
  wrapText,
  clipLine,
  clipVisible,
  visibleWidth,
  entryGlyph,
  entryLabel,
  turnIndicator,
  advanceTurn,
  seedTranscriptFromHistory,
  userPromptsFromHistory,
  createPromptHistory,
  recallOlder,
  recallNewer,
  commitDraft,
  pushPromptHistory,
  submitAllowed,
  cancelDecision,
  footerHints,
  renderShortcutHelp,
  questionMarkOpensHelp,
  SHORTCUT_HELP,
  SHORTCUT_HELP_TITLE,
  toolOpGlyph,
  toolOpLabel,
  sanitizeToolText,
  formatDuration,
  boundToolOutput,
  makeToolOperation,
  toolSummaryLine,
  toolDetailLines,
  toolOpHasDetail,
  toolExpandMarker,
  diffLines,
  buildFileDiff,
  deriveFileDiff,
  diffStatLine,
  diffLinePrefix,
  renderDiffBody,
  deriveFailure,
  failureAction,
  suggestNextStep,
  renderFailureSummary,
  entryStartLines,
  scrollToKeepAnchor,
  resizeScrollOffset,
  COMPOSER_MAX_ROWS,
  TRANSCRIPT_PREVIEW_LINES,
} from "../../src/tui-shell.js";
import type {
  ComposerMode,
  PromptHistory,
  ShellState,
  StatusInfo,
  ToolOpState,
  ToolOperation,
  TranscriptEntry,
  TranscriptKind,
  TurnPhase,
  TurnState,
} from "../../src/tui-shell.js";

const ANSI = /\x1b\[/;

function baseState(over: Partial<ShellState> = {}): ShellState {
  return {
    viewport: { rows: 24, cols: 80 },
    version: "0.1.0",
    transcript: [],
    composer: { mode: "focused", text: "", placeholder: "Ask a question" },
    status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: null },
    color: true,
    turn: { phase: "idle" },
    ...over,
  };
}

describe("tui-shell: computeLayout viewport allocation", () => {
  it("partitions the viewport into contiguous regions that sum to the row count", () => {
    const layout = computeLayout({ rows: 24, cols: 80 }, { composerRows: 2 });
    expect(layout.identityRows + layout.transcriptRows + layout.composerRows + layout.statusRows).toBe(24);
    expect(layout.identity.end).toBe(layout.transcript.start);
    expect(layout.transcript.end).toBe(layout.composer.start);
    expect(layout.composer.end).toBe(layout.status.start);
    expect(layout.status.end).toBe(24);
  });

  it("uses a two-row status footer when space allows", () => {
    for (const rows of [1, 2, 4, 8, 24, 50]) {
      const layout = computeLayout({ rows, cols: 80 }, { composerRows: 2 });
      expect(layout.statusRows).toBe(rows === 1 ? 1 : 2);
      expect(layout.status.end).toBe(rows);
    }
  });

  it("gives the transcript at least one row whenever room allows", () => {
    for (const rows of [4, 6, 10, 24]) {
      const layout = computeLayout({ rows, cols: 80 }, { composerRows: 8 });
      expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
    }
  });

  it("bounds the composer and never lets it crowd out the transcript", () => {
    const layout = computeLayout({ rows: 10, cols: 80 }, { composerRows: 99 });
    expect(layout.composerRows).toBeLessThanOrEqual(COMPOSER_MAX_ROWS);
    expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
  });

  it("drops the identity header on very small terminals", () => {
    const layout = computeLayout({ rows: 2, cols: 80 }, { composerRows: 2 });
    expect(layout.identityRows).toBe(0);
  });
});

describe("tui-shell: bounded multiline growth", () => {
  it("caps the composer band height regardless of input line count", () => {
    expect(composerTotalRows("")).toBe(3); // top rule + input + bottom rule
    expect(composerTotalRows("a\nb\nc")).toBe(5);
    const many = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    expect(composerTotalRows(many)).toBe(COMPOSER_MAX_ROWS);
  });

  it("renders only the bounded tail of a long multiline input, keeping the status row visible", () => {
    const many = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const state = baseState({ composer: { mode: "multiline", text: many, placeholder: "" } });
    const screen = composeScreen(state);
    expect(screen.lines.length).toBe(24);
    // The composer never exceeds the bounded height.
    const layout = computeLayout(state.viewport, { composerRows: composerTotalRows(many) });
    expect(layout.composerRows).toBeLessThanOrEqual(COMPOSER_MAX_ROWS);
    // The newest input line is shown.
    expect(screen.lines.join("\n")).toContain("line29");
  });
});

describe("tui-shell: composer states are color-independent", () => {
  const modes: ComposerMode[] = [
    "idle",
    "focused",
    "multiline",
    "submitting",
    "streaming",
    "cancelled",
    "disabled",
    "error",
  ];

  it("gives every state a distinct glyph and a distinct ASCII label", () => {
    const glyphs = modes.map((m) => composerMarker(m).glyph);
    const labels = modes.map((m) => composerMarker(m).label);
    expect(new Set(glyphs).size).toBe(modes.length);
    expect(new Set(labels).size).toBe(modes.length);
    for (const l of labels) expect(l).toMatch(/^[a-z]+$/);
  });

  it("renders the state label even with color disabled", () => {
    const layout = computeLayout({ rows: 24, cols: 80 }, { composerRows: 2 });
    for (const mode of modes) {
      const lines = renderComposer(
        { mode, text: "hi", placeholder: "" },
        layout,
        shellStyle(false),
      );
      expect(lines.join("\n")).toContain(`${composerMarker(mode).glyph} ${composerMarker(mode).label}`);
      expect(lines.join("\n")).not.toMatch(ANSI);
    }
  });

  it("shows a placeholder only for input-ready states", () => {
    const layout = computeLayout({ rows: 24, cols: 80 }, { composerRows: 2 });
    const idle = renderComposer({ mode: "focused", text: "", placeholder: "PH" }, layout, shellStyle(false));
    expect(idle.join("\n")).toContain("PH");
    const streaming = renderComposer({ mode: "streaming", text: "", placeholder: "PH" }, layout, shellStyle(false));
    expect(streaming.join("\n")).not.toContain("PH");
  });
});

describe("tui-shell: status line is readable and credential-free", () => {
  it("shows model, redacted workspace, and approval mode", () => {
    const info: StatusInfo = {
      model: "fake-model",
      workspace: "~/proj",
      approvalMode: "yolo",
      contextUsage: "tokens 42",
    };
    const layout = computeLayout({ rows: 24, cols: 80 });
    const line = renderStatusLine(info, layout, shellStyle(false)).join("");
    expect(line).toContain("fake-model");
    expect(line).toContain("~/proj");
    expect(line).toContain("approval yolo");
    expect(line).toContain("tokens 42");
  });

  it("surfaces the Tab expand affordance for collapsed transcript blocks", () => {
    const info: StatusInfo = { model: "m", workspace: "~/w", approvalMode: "default" };
    // Steady-state (learned) footer keeps the affordance even at a narrow width.
    const learned = renderStatusLine(info, computeLayout({ rows: 24, cols: 80 }), shellStyle(false), {
      learned: true,
    }).join("");
    expect(learned).toContain("Tab expand");
    // The richer unlearned footer also documents it once there is room for the full hint list.
    const unlearned = renderStatusLine(info, computeLayout({ rows: 24, cols: 120 }), shellStyle(false), {
      learned: false,
    }).join("");
    expect(unlearned).toContain("Tab expand");
  });

  it("never carries a credential because none is ever passed in", () => {
    const info: StatusInfo = { model: "m", workspace: "~/w", approvalMode: "default" };
    const layout = computeLayout({ rows: 24, cols: 80 });
    const line = renderStatusLine(info, layout, shellStyle(false)).join("");
    expect(line).not.toContain("sk-");
    expect(line).not.toContain("api");
  });

  it("clips the status line to the viewport width", () => {
    const info: StatusInfo = {
      model: "x".repeat(200),
      workspace: "~/w",
      approvalMode: "default",
    };
    const layout = computeLayout({ rows: 24, cols: 40 });
    const lines = renderStatusLine(info, layout, shellStyle(false));
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("tui-shell: transcript renders labeled, glanceable blocks", () => {
  it("gives every transcript kind a distinct glyph and label", () => {
    // streaming intentionally shares the assistant glyph/label (it is the live
    // assistant turn), so it is excluded from the distinctness check.
    const kinds: TranscriptKind[] = ["user", "assistant", "tool", "notice", "error"];
    const glyphs = kinds.map(entryGlyph);
    const labels = kinds.map(entryLabel);
    expect(new Set(glyphs).size).toBe(kinds.length);
    expect(new Set(labels).size).toBe(kinds.length);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
  });

  it("renders each entry as a labeled block, newest anchored at the bottom", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world" },
    ];
    const lines = renderTranscript(entries, { start: 0, end: 8 }, 80);
    expect(lines.length).toBe(8);
    const text = lines.join("\n");
    // Each block carries a color-independent glyph + label.
    expect(text).toContain("> You");
    expect(text).toContain("◆ Assistant");
    expect(text).toContain("hello");
    expect(text).toContain("world");
    // Newest content sits at the bottom; the region is top-padded so the
    // composer above it stays put.
    expect(lines[lines.length - 1]).toContain("world");
    expect(lines[0]).toBe("");
  });

  it("shows only the most recent lines when the transcript overflows", () => {
    const entries: TranscriptEntry[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "assistant" as const,
      text: `msg${i}`,
    }));
    const lines = renderTranscript(entries, { start: 0, end: 4 }, 80);
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toContain("msg19");
    expect(lines.join("\n")).not.toContain("msg0");
  });

  it("wraps long lines instead of overflowing horizontally", () => {
    const flat = flattenTranscript([{ kind: "assistant", text: "x".repeat(200) }], 40);
    for (const l of flat) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it("collapses long blocks to a preview with a disclosure marker", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const flat = flattenTranscript([{ kind: "assistant", text: long }], 80);
    expect(flat[0]).toContain("Assistant");
    const bodyLines = flat.filter((l) => l.startsWith("  line "));
    expect(bodyLines.length).toBe(TRANSCRIPT_PREVIEW_LINES);
    expect(flat[flat.length - 1]).toMatch(/\[\+\d+ lines\]/);
  });

  it("expands a collapsed block to full height when its index is expanded", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const collapsed = flattenTranscript([{ kind: "assistant", text: long }], 80);
    const expandedView = flattenTranscript([{ kind: "assistant", text: long }], 80, {
      expanded: new Set([0]),
    });
    expect(expandedView.length).toBeGreaterThan(collapsed.length);
    expect(expandedView.join("\n")).toContain("line 19");
    expect(expandedView.join("\n")).not.toMatch(/\[\+\d+ lines\]/);
  });

  it("never collapses the live streaming block even when long", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const flat = flattenTranscript([{ kind: "streaming", text: long }], 80);
    expect(flat.join("\n")).toContain("line 19");
    expect(flat.join("\n")).not.toMatch(/\[\+\d+ lines\]/);
  });
});

describe("tui-shell: turn indicator is color-independent", () => {
  const phases: TurnPhase[] = [
    "waiting",
    "streaming",
    "running-tool",
    "awaiting-approval",
    "interrupting",
    "cancelled",
    "failed",
    "completed",
  ];

  it("gives every active phase a distinct glyph and a distinct ASCII label", () => {
    const glyphs = phases.map((p) => turnIndicator(p).glyph);
    const labels = phases.map((p) => turnIndicator(p).label);
    expect(new Set(glyphs).size).toBe(phases.length);
    expect(new Set(labels).size).toBe(phases.length);
    for (const l of labels) expect(l).toMatch(/^[a-z ]+$/);
  });

  it("renders nothing in place when idle", () => {
    expect(turnIndicator("idle")).toEqual({ glyph: "", label: "" });
  });
});

describe("tui-shell: advanceTurn drives the active-turn lifecycle", () => {
  it("walks submit → waiting → streaming → tool → waiting → completed in place", () => {
    let t: TurnState = { phase: "idle" };
    t = advanceTurn(t, { type: "submit" });
    expect(t.phase).toBe("waiting");
    t = advanceTurn(t, { type: "stream" });
    expect(t.phase).toBe("streaming");
    t = advanceTurn(t, { type: "tool-start", name: "read_file" });
    expect(t).toEqual({ phase: "running-tool", detail: "read_file" });
    t = advanceTurn(t, { type: "tool-result" });
    expect(t.phase).toBe("waiting");
    t = advanceTurn(t, { type: "complete" });
    expect(t.phase).toBe("completed");
  });

  it("shows an awaiting-approval phase carrying the tool name", () => {
    const t = advanceTurn({ phase: "running-tool", detail: "bash" }, {
      type: "approval-request",
      name: "bash",
    });
    expect(t).toEqual({ phase: "awaiting-approval", detail: "bash" });
  });

  it("reports a failed turn", () => {
    expect(advanceTurn({ phase: "streaming" }, { type: "fail" }).phase).toBe("failed");
  });

  it("clears a terminal outcome only when the user engages again", () => {
    expect(advanceTurn({ phase: "completed" }, { type: "engage" }).phase).toBe("idle");
    expect(advanceTurn({ phase: "failed" }, { type: "engage" }).phase).toBe("idle");
    // Active and idle phases are left untouched by engage.
    expect(advanceTurn({ phase: "streaming" }, { type: "engage" }).phase).toBe("streaming");
    expect(advanceTurn({ phase: "idle" }, { type: "engage" }).phase).toBe("idle");
  });
});

describe("tui-shell: interruption outcomes (pending / cancelled / rejected)", () => {
  it("interrupt while active is pending, then settles to cancelled", () => {
    const pending = advanceTurn({ phase: "streaming" }, { type: "interrupt" });
    expect(pending.phase).toBe("interrupting");
    const settled = advanceTurn(pending, { type: "settle" });
    expect(settled.phase).toBe("cancelled");
  });

  it("rejects an interrupt when no turn is in flight (state unchanged)", () => {
    expect(advanceTurn({ phase: "completed" }, { type: "interrupt" }).phase).toBe("completed");
    expect(advanceTurn({ phase: "idle" }, { type: "interrupt" }).phase).toBe("idle");
  });

  it("ignores a settle that is not preceded by an interrupt", () => {
    expect(advanceTurn({ phase: "streaming" }, { type: "settle" }).phase).toBe("streaming");
  });
});

describe("tui-shell: the active turn renders in place in the composer", () => {
  const layout = computeLayout({ rows: 24, cols: 80 }, { composerRows: 2 });

  it("shows the turn phase on the composer state rule when a turn is live", () => {
    const streaming = renderComposer(
      { mode: "streaming", text: "", placeholder: "PH" },
      layout,
      shellStyle(false),
      { turn: { phase: "streaming" } },
    );
    expect(streaming.join("\n")).toContain("✦ streaming");
    expect(streaming.join("\n")).not.toMatch(ANSI);

    const running = renderComposer(
      { mode: "streaming", text: "", placeholder: "" },
      layout,
      shellStyle(false),
      { turn: { phase: "running-tool", detail: "read_file" } },
    );
    expect(running.join("\n")).toContain("● running tool: read_file");

    const approval = renderComposer(
      { mode: "disabled", text: "", placeholder: "" },
      layout,
      shellStyle(false),
      { turn: { phase: "awaiting-approval", detail: "bash" } },
    );
    expect(approval.join("\n")).toContain("? awaiting approval: bash");
  });

  it("falls back to the composer marker when idle or when no turn is supplied", () => {
    const idle = renderComposer(
      { mode: "focused", text: "hi", placeholder: "" },
      layout,
      shellStyle(false),
      { turn: { phase: "idle" } },
    );
    expect(idle.join("\n")).toContain("❯ edit");
    const none = renderComposer({ mode: "focused", text: "hi", placeholder: "" }, layout, shellStyle(false));
    expect(none.join("\n")).toContain("❯ edit");
  });

  it("surfaces the live turn across the whole screen", () => {
    const text = renderShell(
      baseState({
        turn: { phase: "awaiting-approval", detail: "bash" },
        composer: { mode: "disabled", text: "", placeholder: "" },
      }),
    ).join("\n");
    expect(text).toContain("? awaiting approval: bash");
  });
});

describe("tui-shell: resume restores durable state without transient indicators", () => {
  it("rebuilds durable transcript blocks and omits system + contentless stubs", () => {
    const seeded = seedTranscriptFromHistory([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "assistant", content: null },
      { role: "tool", content: "file contents" },
    ]);
    expect(seeded).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi there" },
      { kind: "tool", text: "file contents" },
    ]);
  });

  it("bounds a large stored tool result so it cannot balloon memory", () => {
    const long = "x".repeat(5000);
    const seeded = seedTranscriptFromHistory([{ role: "tool", content: long }]);
    expect(seeded[0].text.length).toBeLessThan(long.length);
    expect(seeded[0].text).toContain("[truncated]");
  });

  it("shows the prior conversation with the turn idle (no stale streaming/approval indicator)", () => {
    const state = baseState({
      transcript: seedTranscriptFromHistory([{ role: "user", content: "prior question" }]),
      turn: { phase: "idle" },
    });
    const text = renderShell(state).join("\n");
    expect(text).toContain("prior question");
    expect(text).toContain("❯ edit");
    expect(text).not.toContain("✦ streaming");
    expect(text).not.toContain("awaiting approval");
  });
});

describe("tui-shell: whole-screen composition", () => {
  it("uses a Qwen-style product header and quiet first-run canvas", () => {
    const text = renderShell(baseState()).join("\n");
    expect(text).toContain("████ █  █");
    expect(text).toContain(">_ OH MY CLI");
    expect(text).toContain("(/model to change)");
    expect(text).toContain("Tips: /attach an image");
    expect(text).toContain("Ctrl+K");
  });

  it("reduces the identity before sacrificing the composer on short terminals", () => {
    const text = renderShell(baseState({ viewport: { rows: 12, cols: 40 } })).join("\n");
    expect(text).toContain("███ █   █ ███");
    expect(text).toContain("❯ edit");
    expect(text).not.toContain("████ █  █");
  });

  it("renders exactly viewport.rows rows with the composer above the status footer", () => {
    const state = baseState({
      transcript: [{ kind: "assistant", text: "answer" }],
      composer: { mode: "focused", text: "next", placeholder: "" },
    });
    const { lines, cursorRow } = composeScreen(state);
    expect(lines.length).toBe(24);
    const layout = computeLayout(state.viewport, { composerRows: composerTotalRows("next") });
    // Status is the final row.
    expect(lines[23]).toContain("approval default");
    // Cursor sits inside the composer region.
    expect(cursorRow).toBeGreaterThanOrEqual(layout.composer.start);
    expect(cursorRow).toBeLessThan(layout.status.end);
  });

  it("re-allocates the layout on resize while keeping the composer anchored at the bottom", () => {
    const wide = composeScreen(baseState({ viewport: { rows: 24, cols: 80 } }));
    const small = composeScreen(baseState({ viewport: { rows: 10, cols: 40 } }));
    expect(wide.lines.length).toBe(24);
    expect(small.lines.length).toBe(10);
    expect(small.lines[9]).toContain("approval default");
  });

  it("keeps every row within the viewport width", () => {
    const state = baseState({
      transcript: [{ kind: "user", text: "y".repeat(300) }],
      composer: { mode: "multiline", text: "z".repeat(300), placeholder: "" },
      viewport: { rows: 24, cols: 30 },
    });
    for (const line of renderShell(state)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("emits no ANSI escapes when color is disabled but keeps all content", () => {
    const state = baseState({
      color: false,
      transcript: [{ kind: "assistant", text: "plain answer" }],
      composer: { mode: "focused", text: "typed", placeholder: "" },
    });
    const text = renderShell(state).join("\n");
    expect(text).not.toMatch(ANSI);
    expect(text).toContain("plain answer");
    expect(text).toContain("typed");
    expect(text).toContain("❯ edit");
  });
});

describe("tui-shell: text helpers", () => {
  it("wrapLine hard-wraps to width", () => {
    expect(wrapLine("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrapLine("ab", 5)).toEqual(["ab"]);
  });

  it("wrapText preserves newlines and wraps each segment", () => {
    expect(wrapText("ab\ncdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  it("clipLine truncates with an ellipsis", () => {
    expect(clipLine("abcdef", 3)).toBe("ab…");
    expect(clipLine("ab", 5)).toBe("ab");
  });

  it("visibleWidth ignores SGR color escapes", () => {
    expect(visibleWidth("\x1b[1mhi\x1b[0m")).toBe(2);
  });
});

describe("tui-shell: full-screen capability gating", () => {
  it("requires a TTY", () => {
    expect(isFullScreenCapable({ isTTY: false, rows: 24, cols: 80, env: { TERM: "xterm" } })).toBe(false);
  });

  it("accepts a capable terminal", () => {
    expect(isFullScreenCapable({ isTTY: true, rows: 24, cols: 80, env: { TERM: "xterm-256color" } })).toBe(true);
  });

  it("rejects a dumb or unset TERM", () => {
    expect(isFullScreenCapable({ isTTY: true, rows: 24, cols: 80, env: { TERM: "dumb" } })).toBe(false);
    expect(isFullScreenCapable({ isTTY: true, rows: 24, cols: 80, env: {} })).toBe(false);
  });

  it("rejects too-small dimensions", () => {
    expect(isFullScreenCapable({ isTTY: true, rows: 3, cols: 80, env: { TERM: "xterm" } })).toBe(false);
    expect(isFullScreenCapable({ isTTY: true, rows: 24, cols: 10, env: { TERM: "xterm" } })).toBe(false);
  });
});

describe("tui-shell: userPromptsFromHistory seeds recall", () => {
  it("extracts non-empty user prompts in chronological order", () => {
    const prompts = userPromptsFromHistory([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
      { role: "tool", content: "output" },
      { role: "user", content: "   " }, // whitespace-only dropped
      { role: "system", content: "ignored" },
      { role: "user", content: "third" },
    ]);
    expect(prompts).toEqual(["first", "second", "third"]);
  });

  it("treats missing or non-string content as empty", () => {
    expect(userPromptsFromHistory([{ role: "user" }, { role: "user", content: null }])).toEqual([]);
  });
});

describe("tui-shell: prompt-history navigation preserves the draft", () => {
  const seeded = (): PromptHistory => createPromptHistory(["a", "b", "c"]);

  it("starts at the draft slot just past the newest entry", () => {
    const h = createPromptHistory(["a", "b"]);
    expect(h.position).toBe(2);
    expect(h.draft).toBe("");
  });

  it("recalls older prompts and preserves the in-progress draft", () => {
    let h = seeded();
    let r = recallOlder(h, "drafting");
    expect(r.text).toBe("c"); // newest first
    expect(r.history.draft).toBe("drafting");
    h = r.history;
    r = recallOlder(h, "c");
    expect(r.text).toBe("b");
    expect(r.history.draft).toBe("drafting"); // draft untouched while navigating
    h = r.history;
    r = recallOlder(h, "b");
    expect(r.text).toBe("a");
    h = r.history;
    r = recallOlder(h, "a"); // oldest boundary: no-op
    expect(r.text).toBe("a");
    expect(r.history).toBe(h);
  });

  it("returns toward the draft and restores it at the bottom boundary", () => {
    let h = seeded();
    h = recallOlder(h, "drafting").history; // -> c
    h = recallOlder(h, "c").history; // -> b
    let r = recallNewer(h, "b"); // -> c
    expect(r.text).toBe("c");
    h = r.history;
    r = recallNewer(h, "c"); // -> draft restored
    expect(r.text).toBe("drafting");
    expect(r.history.position).toBe(3);
    h = r.history;
    r = recallNewer(h, "drafting"); // draft boundary: no-op
    expect(r.text).toBe("drafting");
    expect(r.history).toBe(h);
  });

  it("keeps an edited recall as the draft on the next recall", () => {
    let h = seeded();
    h = recallOlder(h, "draft").history; // viewing "c"
    h = commitDraft(h, "c edited"); // user typed onto the recalled prompt
    expect(h.position).toBe(3);
    expect(h.draft).toBe("c edited");
    const r = recallOlder(h, "c edited");
    expect(r.history.draft).toBe("c edited");
    expect(r.text).toBe("c");
  });

  it("is a no-op with empty history", () => {
    const h = createPromptHistory([]);
    expect(recallOlder(h, "x").history).toBe(h);
    expect(recallOlder(h, "x").text).toBe("x");
    expect(recallNewer(h, "x").history).toBe(h);
  });
});

describe("tui-shell: pushPromptHistory records sends", () => {
  it("appends the prompt and resets to a fresh draft", () => {
    const h = pushPromptHistory(createPromptHistory(["a"]), "b");
    expect(h.entries).toEqual(["a", "b"]);
    expect(h.position).toBe(2);
    expect(h.draft).toBe("");
  });

  it("skips a consecutive duplicate", () => {
    expect(pushPromptHistory(createPromptHistory(["a"]), "a").entries).toEqual(["a"]);
  });

  it("ignores empty/whitespace sends", () => {
    const h = pushPromptHistory(createPromptHistory(["a"]), "   ");
    expect(h.entries).toEqual(["a"]);
    expect(h.position).toBe(1);
  });
});

describe("tui-shell: submitAllowed makes busy/empty/repeated submissions no-ops", () => {
  it("allows an editable composer holding non-empty text", () => {
    expect(submitAllowed("focused", "hello")).toBe(true);
    expect(submitAllowed("multiline", "a\nb")).toBe(true);
    expect(submitAllowed("error", "retry")).toBe(true);
    expect(submitAllowed("cancelled", "again")).toBe(true);
  });

  it("rejects busy submission while a turn is in flight", () => {
    expect(submitAllowed("submitting", "hello")).toBe(false);
    expect(submitAllowed("streaming", "hello")).toBe(false);
    expect(submitAllowed("disabled", "hello")).toBe(false);
  });

  it("rejects empty and whitespace-only submission", () => {
    expect(submitAllowed("focused", "")).toBe(false);
    expect(submitAllowed("focused", "   \n ")).toBe(false);
  });
});

describe("tui-shell: cancelDecision distinguishes interrupt from clear", () => {
  it("interrupts an active turn", () => {
    expect(cancelDecision({ phase: "streaming" }, true)).toBe("interrupt");
    expect(cancelDecision({ phase: "waiting" }, false)).toBe("interrupt");
    expect(cancelDecision({ phase: "running-tool", detail: "x" }, false)).toBe("interrupt");
    expect(cancelDecision({ phase: "awaiting-approval", detail: "y" }, false)).toBe("interrupt");
  });

  it("clears a draft when no turn is active", () => {
    expect(cancelDecision({ phase: "idle" }, true)).toBe("clear-draft");
    expect(cancelDecision({ phase: "completed" }, true)).toBe("clear-draft");
  });

  it("dismisses a finished turn's lingering outcome when there is no draft", () => {
    expect(cancelDecision({ phase: "completed" }, false)).toBe("dismiss-outcome");
    expect(cancelDecision({ phase: "failed" }, false)).toBe("dismiss-outcome");
    expect(cancelDecision({ phase: "cancelled" }, false)).toBe("dismiss-outcome");
  });

  it("exits when idle with no draft", () => {
    expect(cancelDecision({ phase: "idle" }, false)).toBe("exit");
  });
});

describe("tui-shell: footer hints document bindings and compress once learned", () => {
  it("documents send, newline, and history before the flow is learned", () => {
    const hints = footerHints(false);
    expect(hints).toContain("Enter send");
    expect(hints).toContain("Alt+Enter newline");
    expect(hints).toContain("Up history");
    expect(hints).toContain("Tab expand");
  });

  it("compresses to discovery affordances once learned", () => {
    const hints = footerHints(true);
    expect(hints).not.toContain("Enter send");
    expect(hints).not.toContain("Alt+Enter newline");
    expect(hints).not.toContain("Up history");
    expect(hints).toContain("Tab expand");
  });

  it("is plain text with no color escapes", () => {
    expect(ANSI.test(footerHints(false))).toBe(false);
    expect(ANSI.test(footerHints(true))).toBe(false);
  });

  it("renders fuller hints until learned and compresses afterward", () => {
    const info: StatusInfo = { model: "m", workspace: "~/w", approvalMode: "default" };
    const layout = computeLayout({ rows: 24, cols: 120 });
    const unlearned = renderStatusLine(info, layout, shellStyle(false), { learned: false }).join("");
    const learned = renderStatusLine(info, layout, shellStyle(false), { learned: true }).join("");
    expect(unlearned).toContain("Enter send");
    expect(learned).not.toContain("Enter send");
    for (const line of [unlearned, learned]) {
      expect(line).toContain("approval default");
      expect(line).toContain("Tab expand");
    }
  });

  it("composeScreen compresses the footer once the flow is learned", () => {
    const fresh = composeScreen(baseState({ hintsLearned: false })).lines.join("\n");
    const learned = composeScreen(baseState({ hintsLearned: true })).lines.join("\n");
    expect(fresh).toContain("Enter send");
    expect(learned).not.toContain("Enter send");
  });
});

describe("tui-shell: keyboard-shortcut help panel (Issue #169)", () => {
  const STRIP_ANSI = /\x1b\[[0-9;]*m/g;

  it("lists the real active shortcuts under a stable title", () => {
    const text = renderShortcutHelp(80).join("\n");
    expect(text).toContain(SHORTCUT_HELP_TITLE);
    // Every advertised shortcut is one the driver actually honors.
    for (const entry of SHORTCUT_HELP) {
      expect(text).toContain(entry.keys.trim());
      expect(text).toContain(entry.action);
    }
    // The headline bindings named in the issue are all present.
    for (const chord of ["Enter", "Ctrl+K", "Tab", "Ctrl+C", "Ctrl+D", "Ctrl+L"]) {
      expect(text).toContain(chord);
    }
  });

  it("is color-independent: identical visible text across color depths", () => {
    const plain = renderShortcutHelp(80).join("\n");
    const colored = renderShortcutHelp(80, shellStyle(true)).join("\n");
    const reduced = renderShortcutHelp(80, shellStyle("basic")).join("\n");
    expect(ANSI.test(plain)).toBe(false);
    // Color is a bonus cue: stripping it yields the exact no-color panel.
    expect(colored.replace(STRIP_ANSI, "")).toBe(plain);
    expect(reduced.replace(STRIP_ANSI, "")).toBe(plain);
  });

  it("never overflows the requested width, even when very narrow", () => {
    for (const width of [1, 2, 20, 40, 80, 120, 160]) {
      for (const line of renderShortcutHelp(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("carries no secret or host path (static content only)", () => {
    const text = renderShortcutHelp(120).join("\n");
    expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\Users/i);
    expect(text).not.toMatch(/api[_-]?key|token|password|secret/i);
  });

  it("toggle rule: `?` opens help only on an empty composer", () => {
    expect(questionMarkOpensHelp("")).toBe(true);
    expect(questionMarkOpensHelp("hi")).toBe(false);
    expect(questionMarkOpensHelp("?")).toBe(false);
    expect(questionMarkOpensHelp(" ")).toBe(false);
  });

  it("composeScreen shows the panel in place, bounded to the viewport at every target size", () => {
    for (const viewport of [
      { rows: 24, cols: 80 },
      { rows: 36, cols: 120 },
      { rows: 48, cols: 160 },
    ]) {
      const { lines } = composeScreen(baseState({ helpOpen: true, viewport }));
      expect(lines.length).toBe(viewport.rows);
      const text = lines.join("\n");
      expect(text).toContain(SHORTCUT_HELP_TITLE);
      // The full shortcut list is visible at every target size (nothing clipped away).
      for (const entry of SHORTCUT_HELP) {
        expect(text).toContain(entry.action);
      }
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(viewport.cols);
      }
      // Composer + status stay anchored below the panel.
      expect(lines[viewport.rows - 1]).toContain("approval default");
    }
  });

  it("composeScreen renders the panel with no ANSI when color is disabled", () => {
    const text = composeScreen(baseState({ helpOpen: true, color: false })).lines.join("\n");
    expect(ANSI.test(text)).toBe(false);
    expect(text).toContain(SHORTCUT_HELP_TITLE);
  });

  it("hides the transcript behind the panel and restores it on close", () => {
    const withTranscript = baseState({
      helpOpen: true,
      transcript: [{ kind: "assistant", text: "hidden answer" }],
    });
    const open = composeScreen(withTranscript).lines.join("\n");
    expect(open).toContain(SHORTCUT_HELP_TITLE);
    expect(open).not.toContain("hidden answer");
    const closed = composeScreen({ ...withTranscript, helpOpen: false }).lines.join("\n");
    expect(closed).not.toContain(SHORTCUT_HELP_TITLE);
    expect(closed).toContain("hidden answer");
  });

  it("does not show the panel when helpOpen is unset", () => {
    const text = composeScreen(baseState()).lines.join("\n");
    expect(text).not.toContain(SHORTCUT_HELP_TITLE);
  });
});

describe("tui-shell: composer grows within a bounded height and keeps the viewport stable", () => {
  it("bounds the composer band regardless of how many lines are typed", () => {
    const tall = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    expect(composerTotalRows(tall)).toBe(COMPOSER_MAX_ROWS);
  });

  it("keeps transcript space when the composer is multiline at 120x36", () => {
    const tall = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const layout = computeLayout({ rows: 36, cols: 120 }, { composerRows: composerTotalRows(tall) });
    expect(layout.composerRows).toBeLessThanOrEqual(COMPOSER_MAX_ROWS);
    expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
    expect(layout.status.end).toBe(36);
  });

  it("renders only the bounded tail of a tall composer so the active line stays visible", () => {
    const tall = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const state = baseState({
      viewport: { rows: 36, cols: 120 },
      composer: { mode: "multiline", text: tall, placeholder: "" },
    });
    const screen = composeScreen(state);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("line-19"); // newest line kept
    expect(joined).not.toContain("line-0"); // oldest scrolled out of the bounded band
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  });

  it("preserves conversation space across a resize to a short terminal", () => {
    const tall = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const wide = computeLayout({ rows: 36, cols: 120 }, { composerRows: composerTotalRows(tall) });
    const short = computeLayout({ rows: 10, cols: 120 }, { composerRows: composerTotalRows(tall) });
    expect(short.composerRows).toBeLessThanOrEqual(COMPOSER_MAX_ROWS);
    expect(short.transcriptRows).toBeGreaterThanOrEqual(1);
    expect(wide.transcriptRows).toBeGreaterThan(short.transcriptRows);
  });
});

describe("tui-shell: tool operations have stable lifecycle markers (criterion 1)", () => {
  const states: ToolOpState[] = ["running", "succeeded", "failed", "cancelled", "approval-blocked"];

  it("gives every state a distinct, non-color glyph and label", () => {
    const glyphs = states.map(toolOpGlyph);
    const labels = states.map(toolOpLabel);
    expect(new Set(glyphs).size).toBe(5);
    expect(new Set(labels).size).toBe(5);
    expect(labels).toEqual(["running", "succeeded", "failed", "cancelled", "approval-blocked"]);
    for (const g of glyphs) expect(g.length).toBeGreaterThan(0);
  });

  it("formats durations readably", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(1200)).toBe("1.2s");
  });
});

describe("tui-shell: tool summaries never expose secrets (criterion 2)", () => {
  // A deliberately low-entropy decoy: still matched by the redactor's known-token
  // rule (sk- + 16+ chars) so the test exercises real redaction, but with repeated
  // characters and a non-secret variable name so the gitleaks generic-api-key rule
  // (keyword + entropy gate) never flags this fixture as a leaked credential.
  const DECOY = "sk-aaaaaaaaaaaaaaaaaaaa";

  it("redacts tokens and flagged secrets from tool text", () => {
    const clean = sanitizeToolText(`loaded ${DECOY} and API_KEY=hunter2`);
    expect(clean).not.toContain(DECOY);
    expect(clean).not.toContain("hunter2");
    expect(clean).toContain("[REDACTED]");
  });

  it("keeps the collapsed row and expanded detail secret-free", () => {
    const op = makeToolOperation({ name: "shell", state: "succeeded", turnId: 1, output: `token ${DECOY} here` });
    const entries: TranscriptEntry[] = [{ kind: "tool", text: "", tool: op }];
    const collapsed = flattenTranscript(entries, 120, { style: shellStyle(false) }).join("\n");
    const expanded = flattenTranscript(entries, 120, { style: shellStyle(false), expanded: new Set([0]) }).join("\n");
    expect(collapsed).not.toContain(DECOY);
    expect(expanded).not.toContain(DECOY);
  });
});

describe("tui-shell: progressive disclosure of tool detail (criterion 3)", () => {
  const op = makeToolOperation({
    name: "shell",
    state: "failed",
    turnId: 2,
    input: "rm x",
    output: "boom\nstack line",
    durationMs: 5,
  });

  it("collapses to a summary row with an expand marker", () => {
    const entries: TranscriptEntry[] = [{ kind: "error", text: "", tool: op }];
    const collapsed = flattenTranscript(entries, 120, { style: shellStyle(false) }).join("\n");
    expect(collapsed).toContain("shell");
    expect(collapsed).toContain("failed");
    expect(collapsed).toContain("expand for input/output");
    expect(collapsed).not.toContain("input:"); // detail hidden until expanded
  });

  it("expands to sanitized input, output, duration, and receipt", () => {
    const detail = toolDetailLines(op);
    expect(detail.some((l) => l.startsWith("input:"))).toBe(true);
    expect(detail.some((l) => l.startsWith("output:"))).toBe(true);
    expect(detail).toContain("duration: 5ms");
    expect(detail.join("\n")).toContain("rm x");
    expect(detail.join("\n")).toContain("boom");

    const expanded = flattenTranscript([{ kind: "error", text: "", tool: op }], 120, {
      style: shellStyle(false),
      expanded: new Set([0]),
    }).join("\n");
    expect(expanded).toContain("input:");
    expect(expanded).toContain("output:");
    expect(expanded).toContain("duration: 5ms");
    expect(expanded).not.toContain("expand for input/output");
  });

  it("treats a running operation with no output as having nothing to expand", () => {
    expect(toolOpHasDetail({ name: "x", state: "running", turnId: 0 })).toBe(false);
    expect(toolOpHasDetail(makeToolOperation({ name: "x", state: "succeeded", turnId: 0, output: "y" }))).toBe(true);
  });

  it("shows the result hint on the summary without the full body", () => {
    const line = toolSummaryLine(makeToolOperation({ name: "read_file", state: "succeeded", turnId: 1, output: "first line\nsecond", durationMs: 42 }));
    expect(line).toContain(toolOpGlyph("succeeded"));
    expect(line).toContain("read_file");
    expect(line).toContain("42ms");
    expect(line).toContain("first line");
    expect(line).not.toContain("second");
  });
});

describe("tui-shell: repeated and nested tool activity stays attributable (criterion 4)", () => {
  it("preserves the owning round on each operation", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool", text: "", tool: makeToolOperation({ name: "read_file", state: "succeeded", turnId: 1, output: "r1" }) },
      { kind: "tool", text: "", tool: makeToolOperation({ name: "shell", state: "succeeded", turnId: 1, output: "s1" }) },
      { kind: "tool", text: "", tool: makeToolOperation({ name: "read_file", state: "succeeded", turnId: 2, output: "r2" }) },
    ];
    expect(entries[0].tool?.turnId).toBe(1);
    expect(entries[1].tool?.turnId).toBe(1);
    expect(entries[2].tool?.turnId).toBe(2);
    const flat = flattenTranscript(entries, 120, { style: shellStyle(false) }).join("\n");
    expect(flat).toContain("shell");
    expect((flat.match(/read_file/g) ?? []).length).toBe(2); // both rounds' reads shown
  });
});

describe("tui-shell: large tool output is bounded with a receipt (criterion 5)", () => {
  it("leaves small output untouched and bounds large output with a receipt", () => {
    expect(boundToolOutput("short")).toEqual({ output: "short" });
    const big = boundToolOutput("x".repeat(50), 10);
    expect(big.output).toContain("… [truncated 40 chars]");
    expect(big.receipt).toContain("10 char cap");
  });

  it("carries the receipt into the expanded detail and never spills the full body", () => {
    const op = makeToolOperation({ name: "shell", state: "succeeded", turnId: 1, output: "z".repeat(6000) });
    expect(op.receipt).toBeDefined();
    expect(op.output).toContain("… [truncated");
    expect(op.output.length).toBeLessThan(6000);
    const flat = flattenTranscript([{ kind: "tool", text: "", tool: op }], 120, {
      style: shellStyle(false),
      expanded: new Set([0]),
    }).join("\n");
    expect(flat).toContain("receipt:");
    expect(flat.length).toBeLessThan(6000);
  });
});

describe("tui-shell: multiple tool operations stay glanceable at 120x36 (criterion 7)", () => {
  it("renders compact collapsed summaries that fit the viewport", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push({
        kind: "tool",
        text: "",
        tool: makeToolOperation({ name: `tool_${i}`, state: "succeeded", turnId: 1, output: `result ${i}\nmore ${i}` }),
      });
    }
    const screen = composeScreen(baseState({ viewport: { rows: 36, cols: 120 }, transcript: entries }));
    for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    const joined = screen.lines.join("\n");
    expect(joined).toContain("result 7"); // newest summary visible
    expect(joined).not.toContain("more 0"); // collapsed detail does not flood the conversation
  });
});

// ---------------------------------------------------------------------------
// Issue #163: inspect diffs and failures without losing conversation context
// ---------------------------------------------------------------------------

describe("tui-shell: diff summaries name files and magnitude before expansion (criterion 1)", () => {
  it("derives a structured edit diff with correct file and change counts", () => {
    const diff = deriveFileDiff("edit", { path: "src/a.ts", oldText: "a\nb\nc", newText: "a\nB\nc" });
    expect(diff).toBeDefined();
    expect(diff?.file).toBe("src/a.ts");
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
  });

  it("renders a one-line stat naming the file and magnitude", () => {
    const diff = deriveFileDiff("edit", { path: "src/a.ts", oldText: "a\nb\nc", newText: "a\nB\nc" })!;
    expect(diffStatLine(diff)).toBe("src/a.ts  +1 -1");
  });

  it("shows the diff stat collapsed, before any expansion", () => {
    const op = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "Edited src/a.ts" });
    op.diff = deriveFileDiff("edit", { path: "src/a.ts", oldText: "a\nb", newText: "a\nB" });
    const collapsed = flattenTranscript([{ kind: "tool", text: "", tool: op }], 120, {
      style: shellStyle(false),
    }).join("\n");
    expect(collapsed).toContain("src/a.ts  +1 -1"); // magnitude visible without expanding
    expect(collapsed).not.toContain("- b"); // the diff body stays hidden until expanded
    expect(collapsed).toContain("expand for diff");
  });

  it("treats a write as additions and ignores non-file or no-op calls", () => {
    expect(deriveFileDiff("write", { path: "x.ts", content: "a\nb" })?.added).toBe(2);
    expect(deriveFileDiff("write", { path: "x.ts", content: "a\nb" })?.removed).toBe(0);
    expect(deriveFileDiff("shell", { command: "ls" })).toBeUndefined();
    expect(deriveFileDiff("edit", { oldText: "a", newText: "b" })).toBeUndefined(); // no path
    expect(deriveFileDiff("edit", { path: "x", oldText: "a", newText: "a" })).toBeUndefined(); // no-op
    expect(deriveFileDiff("write", { path: "x", content: "" })).toBeUndefined(); // empty
  });
});

describe("tui-shell: expanded diffs distinguish +/-/context without color (criterion 2)", () => {
  it("computes an interleaved line diff", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ]);
  });

  it("uses distinct ASCII prefixes per kind", () => {
    expect(diffLinePrefix("add")).toBe("+ ");
    expect(diffLinePrefix("del")).toBe("- ");
    expect(diffLinePrefix("context")).toBe("  ");
    const body = renderDiffBody({ file: "x", added: 1, removed: 1, truncated: false, lines: diffLines("a\nb", "a\nB") });
    expect(body).toEqual(["  a", "- b", "+ B"]);
  });

  it("keeps the +/- distinction with color on AND off (not color-alone)", () => {
    const op = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "Edited" });
    op.diff = deriveFileDiff("edit", { path: "a.ts", oldText: "1\n2\n3", newText: "1\nx\n3" });
    const entries: TranscriptEntry[] = [{ kind: "tool", text: "", tool: op }];
    for (const color of [false, true]) {
      const joined = flattenTranscript(entries, 120, { style: shellStyle(color), expanded: new Set([0]) }).join("\n");
      expect(joined).toContain("+ x"); // addition prefix present regardless of color
      expect(joined).toContain("- 2"); // deletion prefix present regardless of color
    }
    // With color disabled there is no ANSI at all, yet the prefixes still differ.
    const plain = flattenTranscript(entries, 120, { style: shellStyle(false), expanded: new Set([0]) }).join("\n");
    expect(ANSI.test(plain)).toBe(false);
  });
});

describe("tui-shell: failures show cause, action, and next step before diagnostics (criterion 3)", () => {
  it("derives a structured failure summary", () => {
    const f = deriveFailure("edit", { path: "src/a.ts" }, { content: "Error: oldText not found in src/a.ts", isError: true });
    expect(f?.cause).toBe("Error: oldText not found in src/a.ts");
    expect(f?.action).toBe("edit src/a.ts");
    expect(f?.nextStep).toBe("check the path and retry");
  });

  it("returns undefined for non-error results", () => {
    expect(deriveFailure("edit", { path: "x" }, { content: "ok" })).toBeUndefined();
  });

  it("names the affected action per tool", () => {
    expect(failureAction("read", { path: "p" })).toBe("read p");
    expect(failureAction("glob", { pattern: "**/*.ts" })).toBe("glob **/*.ts");
    expect(failureAction("grep", { pattern: "foo" })).toBe("grep foo");
    expect(failureAction("shell", { command: "npm test" })).toBe("shell npm test");
    expect(failureAction("shell", {})).toBe("shell"); // missing arg falls back to the name
    expect(failureAction("mystery", {})).toBe("mystery");
  });

  it("suggests a safe, deterministic next step from the cause", () => {
    expect(suggestNextStep("Tool execution denied by user", "edit")).toBe("approve the action or adjust the request");
    expect(suggestNextStep("oldText appears 3 times", "edit")).toBe("narrow oldText to a unique, exact match");
    expect(suggestNextStep("command not found: tsc", "shell")).toBe("verify the command exists and is on PATH");
    expect(suggestNextStep("ENOENT: no such file", "read")).toBe("check the path and retry");
    expect(suggestNextStep("EACCES: permission denied", "write")).toBe("check permissions for this path");
    expect(suggestNextStep("operation timed out", "shell")).toBe("narrow the operation's scope or raise the timeout");
    expect(suggestNextStep("something weird", "edit")).toBe("review the diagnostic and retry");
  });

  it("shows the summary collapsed and the verbose diagnostics only when expanded", () => {
    const op = makeToolOperation({ name: "shell", state: "failed", turnId: 1, output: "boom\nlong stack trace line" });
    op.failure = deriveFailure("shell", { command: "build" }, { content: "boom\nlong stack trace line", isError: true });
    const entries: TranscriptEntry[] = [{ kind: "error", text: "", tool: op }];
    const collapsed = flattenTranscript(entries, 120, { style: shellStyle(false) }).join("\n");
    expect(collapsed).toContain("cause: boom");
    expect(collapsed).toContain("action: shell build");
    expect(collapsed).toContain("next: review the diagnostic and retry");
    expect(collapsed).not.toContain("long stack trace line"); // diagnostics hidden until expanded
    expect(collapsed).toContain("expand for diagnostics");

    const expanded = flattenTranscript(entries, 120, { style: shellStyle(false), expanded: new Set([0]) }).join("\n");
    expect(expanded).toContain("long stack trace line"); // verbose diagnostics now shown
    expect(expanded).toContain("cause: boom"); // summary still precedes them
  });

  it("labels the expand marker by what disclosure reveals", () => {
    const diffOp = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "x" });
    diffOp.diff = deriveFileDiff("edit", { path: "a", oldText: "1", newText: "2" });
    expect(toolExpandMarker(diffOp)).toBe("… [expand for diff]");
    const failOp = makeToolOperation({ name: "shell", state: "failed", turnId: 1, output: "e" });
    failOp.failure = { cause: "e", action: "shell x", nextStep: "retry" };
    expect(toolExpandMarker(failOp)).toBe("… [expand for diagnostics]");
    const both = makeToolOperation({ name: "edit", state: "failed", turnId: 1, output: "e" });
    both.diff = deriveFileDiff("edit", { path: "a", oldText: "1", newText: "2" });
    both.failure = { cause: "e", action: "edit a", nextStep: "retry" };
    expect(toolExpandMarker(both)).toBe("… [expand for diff and diagnostics]");
    expect(toolExpandMarker(makeToolOperation({ name: "read", state: "succeeded", turnId: 1, output: "x" }))).toBe(
      "… [expand for input/output]",
    );
  });
});

describe("tui-shell: expand/collapse preserves the selected event and scroll (criterion 4)", () => {
  const cols = 80;
  const height = 6;
  const opA = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "Edited a" });
  opA.diff = deriveFileDiff("edit", { path: "a.ts", oldText: "1\n2\n3", newText: "1\nx\n3" });
  const opB = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "Edited b" });
  opB.diff = deriveFileDiff("edit", { path: "b.ts", oldText: "p\nq", newText: "p\nr\ns\nq" });
  const filler: TranscriptEntry = {
    kind: "assistant",
    text: Array.from({ length: 12 }, (_, i) => `f${i}`).join("\n"),
  };
  const entries: TranscriptEntry[] = [
    { kind: "tool", text: "", tool: opA },
    filler,
    { kind: "tool", text: "", tool: opB },
  ];
  const sel = 2; // the newest expandable block (opB)

  function anchorRow(expandedSet: Set<number>, scroll: number): number {
    const starts = entryStartLines(entries, cols, { expanded: expandedSet });
    const flatLen = flattenTranscript(entries, cols, { expanded: expandedSet }).length;
    const sc = Math.max(0, Math.min(scroll, Math.max(0, flatLen - height)));
    return starts[sel] - (flatLen - sc - height);
  }

  it("records strictly increasing per-entry start lines", () => {
    const starts = entryStartLines(entries, cols, { expanded: new Set() });
    expect(starts.length).toBe(entries.length);
    expect(starts[0]).toBe(0);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
  });

  it("keeps the toggled block at the same viewport row across expand", () => {
    const before = new Set<number>();
    const after = new Set<number>([sel]);
    const startsBefore = entryStartLines(entries, cols, { expanded: before });
    const startsAfter = entryStartLines(entries, cols, { expanded: after });
    const scrollBefore = 0;
    const scrollAfter = scrollToKeepAnchor({
      flatLenBefore: flattenTranscript(entries, cols, { expanded: before }).length,
      flatLenAfter: flattenTranscript(entries, cols, { expanded: after }).length,
      anchorBefore: startsBefore[sel],
      anchorAfter: startsAfter[sel],
      scrollBefore,
      height,
    });
    expect(scrollAfter).toBeGreaterThan(0); // it scrolled up to hold the block in place
    expect(anchorRow(before, scrollBefore)).toBe(anchorRow(after, scrollAfter));
  });

  it("clamps the preserved scroll to the scrollable range", () => {
    expect(scrollToKeepAnchor({ flatLenBefore: 10, flatLenAfter: 20, anchorBefore: 4, anchorAfter: 4, scrollBefore: 0, height: 8 })).toBe(10);
    expect(scrollToKeepAnchor({ flatLenBefore: 10, flatLenAfter: 12, anchorBefore: 2, anchorAfter: 9, scrollBefore: 0, height: 8 })).toBe(0);
    expect(scrollToKeepAnchor({ flatLenBefore: 5, flatLenAfter: 6, anchorBefore: 0, anchorAfter: 0, scrollBefore: 0, height: 50 })).toBe(0);
  });

  it("scrolls the transcript window without pinning to the newest", () => {
    const tall: TranscriptEntry[] = [{ kind: "assistant", text: Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n") }];
    const region = { start: 0, end: 5 };
    const atBottom = renderTranscript(tall, region, cols, { expanded: new Set([0]), scroll: 0 }).join("\n");
    expect(atBottom).toContain("L19");
    expect(atBottom).not.toContain("L0");
    const scrolled = renderTranscript(tall, region, cols, { expanded: new Set([0]), scroll: 15 }).join("\n");
    expect(scrolled).toContain("L0");
    expect(scrolled).not.toContain("L19");
  });
});

describe("tui-shell: long diffs and stack traces stay bounded with a receipt (criterion 5)", () => {
  // Reuse the low-entropy decoy from the #162 suite: caught by the redactor's
  // known-token rule but never flagged by gitleaks' generic-api-key entropy gate.
  const DECOY = "sk-aaaaaaaaaaaaaaaaaaaa";

  it("bounds a large diff while reporting full magnitude", () => {
    const big = buildFileDiff("huge.ts", "", Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n"));
    expect(big.added).toBe(250); // magnitude reflects the whole change
    expect(big.removed).toBe(0);
    expect(big.truncated).toBe(true);
    expect(big.lines.length).toBe(200); // body bounded to MAX_DIFF_LINES
    const body = renderDiffBody(big);
    expect(body[body.length - 1]).toContain("diff truncated to 200 lines");
    expect(body[body.length - 1]).toContain("full redacted change retained");
  });

  it("falls back to a coarse diff for very large inputs", () => {
    const oldText = Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n");
    const newText = [...Array.from({ length: 500 }, (_, i) => `line ${i}`), "changed"].join("\n");
    const diff = buildFileDiff("big.ts", oldText, newText);
    // A 501-line side exceeds the LCS guard, so the coarse path reports every old
    // line removed and every new line added (an LCS diff would report far fewer).
    expect(diff.added).toBe(501);
    expect(diff.removed).toBe(501);
    expect(diff.truncated).toBe(true);
  });

  it("redacts secrets in diff content so an expanded diff never leaks them", () => {
    const op = makeToolOperation({ name: "write", state: "succeeded", turnId: 1, output: "Wrote .env" });
    op.diff = deriveFileDiff("write", { path: ".env", content: `TOKEN=${DECOY}` });
    const expanded = flattenTranscript([{ kind: "tool", text: "", tool: op }], 120, {
      style: shellStyle(false),
      expanded: new Set([0]),
    }).join("\n");
    expect(expanded).not.toContain(DECOY);
    expect(expanded).toContain("[REDACTED]");
  });

  it("bounds a failure's cause to a single line", () => {
    const long = "x".repeat(300);
    const f = deriveFailure("shell", { command: "c" }, { content: long, isError: true });
    expect(f!.cause.length).toBeLessThanOrEqual(121); // 120 chars + ellipsis
  });
});

describe("tui-shell: a diff and a recoverable failure render in context at 120x36 (criterion 7)", () => {
  it("shows both summaries within the viewport, color and reduced-color", () => {
    const editOp = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "Edited src/a.ts (single occurrence replaced).", durationMs: 12 });
    editOp.diff = deriveFileDiff("edit", { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" });
    const failOp = makeToolOperation({ name: "shell", state: "failed", turnId: 1, output: "npm error command not found: tscx" });
    failOp.failure = deriveFailure("shell", { command: "tscx" }, { content: "npm error command not found: tscx", isError: true });
    const entries: TranscriptEntry[] = [
      { kind: "tool", text: "", tool: editOp },
      { kind: "error", text: "", tool: failOp },
    ];
    for (const color of [true, false]) {
      const screen = composeScreen(baseState({ viewport: { rows: 36, cols: 120 }, color, transcript: entries }));
      for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
      const joined = screen.lines.join("\n");
      expect(joined).toContain("src/a.ts  +1 -1"); // diff magnitude in context
      expect(joined).toContain("cause: npm error command not found: tscx"); // failure cause
      expect(joined).toContain("action: shell tscx"); // affected action
      expect(joined).toContain("next: verify the command exists and is on PATH"); // safe next step
    }
  });
});

describe("tui-shell: coherent layout across compact, standard, and wide terminals (Issue #164, criterion 1)", () => {
  const sizes = [
    { rows: 24, cols: 80 }, // compact / standard
    { rows: 36, cols: 120 }, // standard
    { rows: 48, cols: 160 }, // wide
  ];

  function richState(rows: number, cols: number): ShellState {
    const op = makeToolOperation({ name: "edit", state: "running", turnId: 1 });
    return baseState({
      viewport: { rows, cols },
      transcript: [
        { kind: "user", text: "Refactor the layout helper and add tests." },
        { kind: "assistant", text: "Sure, here is the change to computeLayout that keeps the regions contiguous." },
        { kind: "tool", text: "", tool: op },
      ],
      composer: { mode: "streaming", text: "", placeholder: "Ask a question" },
      turn: { phase: "running-tool", detail: "edit" },
      status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: "tokens 1234" },
    });
  }

  it("partitions every size into contiguous regions that sum to the row count", () => {
    for (const { rows, cols } of sizes) {
      const layout = computeLayout({ rows, cols }, { composerRows: composerTotalRows("") });
      expect(layout.identityRows + layout.transcriptRows + layout.composerRows + layout.statusRows).toBe(rows);
      expect(layout.identity.end).toBe(layout.transcript.start);
      expect(layout.transcript.end).toBe(layout.composer.start);
      expect(layout.composer.end).toBe(layout.status.start);
      expect(layout.status.end).toBe(rows);
      // The composer and status footer are always present at these sizes (no hidden
      // critical state).
      expect(layout.composerRows).toBeGreaterThan(0);
      expect(layout.statusRows).toBe(2);
    }
  });

  it("renders every size with the exact row count and no horizontal overflow", () => {
    for (const { rows, cols } of sizes) {
      const screen = composeScreen(richState(rows, cols));
      expect(screen.lines).toHaveLength(rows);
      for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
    }
  });

  it("keeps critical state visible at every size: active turn, tool, and status footer", () => {
    for (const { rows, cols } of sizes) {
      const joined = composeScreen(richState(rows, cols)).lines.join("\n");
      expect(joined).toContain("running tool"); // active turn indicator, rendered in place
      expect(joined).toContain("edit"); // the running tool / turn detail
      expect(joined).toContain("approval default"); // status footer
      expect(joined).toContain("fake-model"); // model in identity/status
    }
  });
});

describe("tui-shell: color modes — none, basic (reduced), and 256 (Issue #164, criterion 3)", () => {
  it("emits no ANSI for NO_COLOR / color:false", () => {
    const s = shellStyle(false);
    expect(s.accent).toBe("");
    expect(s.success).toBe("");
    const screen = composeScreen(baseState({ color: false })).lines.join("");
    expect(screen).not.toMatch(ANSI);
  });

  it("uses the portable 16-color SGR set for a basic (reduced-color) terminal", () => {
    const basic = shellStyle("basic");
    expect(basic.accent).toBe("\x1b[36m"); // cyan
    expect(basic.accentSoft).toBe("\x1b[35m"); // magenta
    expect(basic.success).toBe("\x1b[32m"); // green
    // Never the indexed 256-color form a reduced-color terminal cannot map.
    expect(basic.accent).not.toContain("38;5");
    expect(basic.success).not.toContain("38;5");
  });

  it("uses the indexed 256-color palette for 256/truecolor and legacy boolean true", () => {
    expect(shellStyle("256").accent).toBe("\x1b[38;5;81m");
    expect(shellStyle("truecolor").accent).toBe("\x1b[38;5;81m");
    expect(shellStyle(true).accent).toBe("\x1b[38;5;81m");
  });

  it("clips colored text by visible cells so color codes never truncate early", () => {
    const colored = "\x1b[1m>_ OH MY CLI\x1b[0m  \x1b[2m(v0.1.0)\x1b[0m";
    // clipLine counts raw chars (incl. escapes) and would cut the version short;
    // clipVisible counts only visible cells, so the full text fits at its width.
    expect(visibleWidth(colored)).toBe(22);
    expect(clipVisible(colored, 30)).toBe(colored); // 22 visible cells <= 30, untouched
    expect(clipVisible(colored, 30)).toContain("(v0.1.0)");
    // When genuinely too long, it ellipsizes by visible width and keeps escapes intact.
    const clipped = clipVisible(colored, 12);
    expect(visibleWidth(clipped)).toBe(12); // 11 cells + ellipsis
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toContain("[1m…"); // no broken escape fragment
  });

  it("communicates every state through text + structure identically across depths", () => {
    const op = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "ok" });
    op.diff = deriveFileDiff("edit", { path: "a.ts", oldText: "x", newText: "y" });
    const entries: TranscriptEntry[] = [{ kind: "tool", text: "", tool: op }];
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
    const render = (depth: "none" | "basic" | "256"): string =>
      composeScreen(
        baseState({ colorDepth: depth, turn: { phase: "completed" }, transcript: entries, expanded: new Set([0]) }),
      )
        .lines.map(strip)
        .join("\n");
    const none = render("none");
    // Only the (stripped) ANSI differs between depths; the text/structure is identical.
    expect(render("basic")).toBe(none);
    expect(render("256")).toBe(none);
    // State is conveyed by structure/text alone, with no color at all.
    expect(none).toContain("✓"); // tool succeeded glyph
    expect(none).toContain("succeeded"); // tool label
    expect(none).toContain("a.ts  +1 -1"); // diff magnitude
    expect(none).toContain("+ "); // diff addition prefix (expanded body)
    expect(none).toContain("completed"); // turn outcome label
  });
});

describe("tui-shell: visible textual scroll focus (Issue #164, criterion 4)", () => {
  const info: StatusInfo = { model: "m", workspace: "~/p", approvalMode: "default", contextUsage: null };
  const layout = computeLayout({ rows: 24, cols: 80 });

  it("shows no scroll marker when pinned to the newest", () => {
    const line = renderStatusLine(info, layout, shellStyle(false), { scroll: 0 }).join("");
    expect(line).not.toContain("up  ·");
    expect(line).toContain("approval default");
  });

  it("shows a textual '↑ N up' marker when scrolled up", () => {
    const line = renderStatusLine(info, layout, shellStyle(false), { scroll: 7 }).join("");
    expect(line).toContain("↑ 7 up");
  });

  it("surfaces the marker through composeScreen when the transcript is scrolled", () => {
    const joined = composeScreen(baseState({ scroll: 5 })).lines.join("\n");
    expect(joined).toContain("↑ 5 up");
  });
});

describe("tui-shell: resize re-anchors the transcript (Issue #164, criteria 2 & 5)", () => {
  const longEntries: TranscriptEntry[] = Array.from({ length: 12 }, (_, i) => ({
    kind: "assistant" as const,
    text: `Answer block number ${i} padded with sufficient words to wrap when the terminal narrows to eighty columns.`,
  }));

  it("keeps a bottom-pinned view pinned to the newest across a resize", () => {
    const scroll = resizeScrollOffset({
      entries: longEntries,
      oldCols: 120,
      newCols: 80,
      scrollBefore: 0,
      heightBefore: 20,
      heightAfter: 12,
    });
    expect(scroll).toBe(0);
  });

  it("is the identity when neither width nor height changes", () => {
    const scroll = resizeScrollOffset({
      entries: longEntries,
      oldCols: 100,
      newCols: 100,
      scrollBefore: 6,
      heightBefore: 15,
      heightAfter: 15,
    });
    expect(scroll).toBe(6);
  });

  it("returns 0 for an empty transcript and always clamps within the scrollable range", () => {
    expect(
      resizeScrollOffset({ entries: [], oldCols: 120, newCols: 80, scrollBefore: 9, heightBefore: 10, heightAfter: 10 }),
    ).toBe(0);
    const height = 8;
    const maxScroll = Math.max(0, flattenTranscript(longEntries, 80, {}).length - height);
    const s = resizeScrollOffset({
      entries: longEntries,
      oldCols: 120,
      newCols: 80,
      scrollBefore: 999,
      heightBefore: height,
      heightAfter: height,
    });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(maxScroll);
  });

  it("keeps the entry at the top of the window visible after narrowing the terminal", () => {
    const expanded = new Set<number>();
    const heightBefore = 10;
    const heightAfter = 10;
    const flatBefore = flattenTranscript(longEntries, 120, { expanded }).length;
    const scrollBefore = flatBefore - heightBefore - 9; // put a middle entry near the top
    const beforeStarts = entryStartLines(longEntries, 120, { expanded });
    const startBefore = Math.max(0, flatBefore - scrollBefore - heightBefore);
    let anchor = 0;
    for (let i = 0; i < beforeStarts.length; i++) {
      if ((beforeStarts[i] ?? 0) <= startBefore) anchor = i;
      else break;
    }
    const scrollAfter = resizeScrollOffset({
      entries: longEntries,
      expanded,
      oldCols: 120,
      newCols: 80,
      scrollBefore,
      heightBefore,
      heightAfter,
    });
    const windowAfter = renderTranscript(longEntries, { start: 0, end: heightAfter }, 80, {
      expanded,
      scroll: scrollAfter,
    });
    expect(windowAfter.join("\n")).toContain(`Answer block number ${anchor}`);
  });

  it("preserves draft, expansion, and the active turn through a mid-stream resize", () => {
    // A realistic mid-stream view is bottom-anchored (watching the answer arrive), so
    // a resize keeps it bottom-anchored; the draft, the expanded tool diff, and the
    // live streaming turn all survive the reflow at the smaller size.
    const editOp = makeToolOperation({ name: "edit", state: "succeeded", turnId: 1, output: "ok", durationMs: 9 });
    editOp.diff = deriveFileDiff("edit", { path: "z.ts", oldText: "a", newText: "b" });
    const entries: TranscriptEntry[] = [
      ...longEntries,
      { kind: "tool", text: "", tool: editOp },
      { kind: "streaming", text: "Here is the live answer streaming in right now." },
    ];
    const expanded = new Set([longEntries.length]); // expand the tool diff near the bottom
    const draft = "draft prompt in progress";
    const before = baseState({
      viewport: { rows: 36, cols: 120 },
      transcript: entries,
      expanded,
      scroll: 0,
      composer: { mode: "streaming", text: draft, placeholder: "" },
      turn: { phase: "streaming" },
    });
    const after = baseState({
      viewport: { rows: 24, cols: 80 },
      transcript: entries,
      expanded,
      scroll: 0,
      composer: { mode: "streaming", text: draft, placeholder: "" },
      turn: { phase: "streaming" },
    });
    for (const st of [before, after]) {
      const screen = composeScreen(st);
      expect(screen.lines).toHaveLength(st.viewport.rows);
      for (const line of screen.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(st.viewport.cols);
      const joined = screen.lines.join("\n");
      expect(joined).toContain(draft); // draft preserved
      expect(joined).toContain("streaming"); // active turn preserved (composer rule)
      expect(joined).toContain("live answer"); // streaming content still visible
      expect(joined).toContain("z.ts  +1 -1"); // expanded diff still disclosed
    }
  });
});

describe("tui-shell: keyboard-only traversal reaches every primary action (Issue #164, criteria 4 & 6)", () => {
  it("Enter submits only editable, non-empty input", () => {
    expect(submitAllowed("focused", "hello")).toBe(true);
    expect(submitAllowed("streaming", "hello")).toBe(false); // busy
    expect(submitAllowed("focused", "   ")).toBe(false); // empty
  });

  it("Ctrl+C interrupts active work, clears a draft, dismisses an outcome, or exits", () => {
    expect(cancelDecision({ phase: "streaming" }, false)).toBe("interrupt");
    expect(cancelDecision({ phase: "idle" }, true)).toBe("clear-draft");
    expect(cancelDecision({ phase: "completed" }, false)).toBe("dismiss-outcome");
    expect(cancelDecision({ phase: "idle" }, false)).toBe("exit");
  });

  it("Up/Down recall prompt history and preserve the in-progress draft", () => {
    const h = createPromptHistory(["first", "second"]);
    const older = recallOlder(h, "drafting");
    expect(older.text).toBe("second");
    const older2 = recallOlder(older.history, "drafting");
    expect(older2.text).toBe("first");
    const newer = recallNewer(older2.history, "first");
    expect(newer.text).toBe("second");
    const backToDraft = recallNewer(newer.history, "second");
    expect(backToDraft.text).toBe("drafting"); // draft restored at the bottom
  });

  it("Tab expand/collapse holds the selected event's row in place", () => {
    // Expanding grows the flattened length; the anchor row is held.
    const scroll = scrollToKeepAnchor({
      flatLenBefore: 20,
      flatLenAfter: 30,
      anchorBefore: 5,
      anchorAfter: 5,
      scrollBefore: 4,
      height: 10,
    });
    expect(scroll).toBe(14); // 4 + (30 - 20) - (5 - 5)
  });
});
