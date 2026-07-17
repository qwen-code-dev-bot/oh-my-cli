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
  COMPOSER_MAX_ROWS,
} from "../../src/tui-shell.js";
import type { ComposerMode, ShellState, StatusInfo, TranscriptEntry } from "../../src/tui-shell.js";

const ANSI = /\x1b\[/;

function baseState(over: Partial<ShellState> = {}): ShellState {
  return {
    viewport: { rows: 24, cols: 80 },
    version: "0.1.0",
    transcript: [],
    composer: { mode: "focused", text: "", placeholder: "Ask a question" },
    status: { model: "fake-model", workspace: "~/proj", approvalMode: "default", contextUsage: null },
    color: true,
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

describe("tui-shell: transcript anchors newest content at the bottom", () => {
  it("top-pads short transcripts so the composer stays put", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world" },
    ];
    const lines = renderTranscript(entries, { start: 0, end: 5 }, 80);
    expect(lines.length).toBe(5);
    expect(lines[lines.length - 1]).toContain("world");
    expect(lines[lines.length - 2]).toContain("hello");
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
});

describe("tui-shell: whole-screen composition", () => {
  it("uses a Qwen-style product header and quiet first-run canvas", () => {
    const text = renderShell(baseState()).join("\n");
    expect(text).toContain("████ █  █");
    expect(text).toContain(">_ OH MY CLI");
    expect(text).toContain("(/model to change)");
    expect(text).toContain("Tips: use @path");
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
