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
  COMPOSER_MAX_ROWS,
  TRANSCRIPT_PREVIEW_LINES,
} from "../../src/tui-shell.js";
import type {
  ComposerMode,
  PromptHistory,
  ShellState,
  StatusInfo,
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
