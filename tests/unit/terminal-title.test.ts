import { describe, it, expect } from "vitest";
import {
  sanitizeTitleText,
  composeTerminalTitle,
  isMultiplexerEnv,
  titleEscapeSequences,
} from "../../src/terminal-title.js";

describe("terminal title sanitization (Issue #785)", () => {
  it("keeps ordinary text including unicode and spaces", () => {
    expect(sanitizeTitleText("my session — 数据")).toBe("my session — 数据");
  });

  it("strips control characters, ESC, and line breaks", () => {
    expect(sanitizeTitleText("a\x07b")).toBe("ab");
    expect(sanitizeTitleText("a\x1b[2Jb")).toBe("a[2Jb");
    expect(sanitizeTitleText("line1\nline2\ttabbed\r")).toBe("line1line2tabbed");
    expect(sanitizeTitleText("del\x7f")).toBe("del");
  });

  it("strips BiDi overrides and invisible direction marks", () => {
    expect(sanitizeTitleText("a\u202eb")).toBe("ab");
    expect(sanitizeTitleText("a\u2066b\u2069")).toBe("ab");
    expect(sanitizeTitleText("a\u200eb\u200f")).toBe("ab");
    expect(sanitizeTitleText("soft\u00adhyphen")).toBe("softhyphen");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeTitleText("  padded  ")).toBe("padded");
    expect(sanitizeTitleText("   ")).toBe("");
  });
});

describe("terminal title composition (Issue #785)", () => {
  it("prefers the explicit text when sanitization removes nothing", () => {
    expect(
      composeTerminalTitle({
        explicitText: "My Work",
        sessionName: "named-session",
        workspaceRoot: "/tmp/proj",
      }),
    ).toBe("My Work");
    // Surrounding whitespace is tolerated (trimmed, still accepted).
    expect(composeTerminalTitle({ explicitText: "  My Work  " })).toBe("My Work");
  });

  it("falls through an injection-only explicit text to the session name", () => {
    expect(
      composeTerminalTitle({
        explicitText: "\u0007\u001b]2;spoof\u0007",
        sessionName: "named-session",
        workspaceRoot: "/tmp/proj",
      }),
    ).toBe("named-session");
  });

  it("uses the session name over the workspace folder", () => {
    expect(
      composeTerminalTitle({ sessionName: "named-session", workspaceRoot: "/tmp/proj" }),
    ).toBe("named-session");
  });

  it("derives 'oh-my-cli — <folder>' from the workspace basename", () => {
    expect(composeTerminalTitle({ workspaceRoot: "/root/qys/my-project" })).toBe(
      "oh-my-cli — my-project",
    );
  });

  it("falls back to the product default with no inputs", () => {
    expect(composeTerminalTitle({})).toBe("oh-my-cli");
    expect(composeTerminalTitle({ explicitText: "   " })).toBe("oh-my-cli");
    expect(composeTerminalTitle({ sessionName: null })).toBe("oh-my-cli");
  });
});

describe("terminal title escape selection (Issue #785)", () => {
  it("detects multiplexer environments (TMUX/STY/ZELLIJ/DVTM)", () => {
    expect(isMultiplexerEnv({ TMUX: "/tmp/tmux-0/default,1,0" })).toBe(true);
    expect(isMultiplexerEnv({ STY: "12345.pts-0.host" })).toBe(true);
    expect(isMultiplexerEnv({ ZELLIJ: "true" })).toBe(true);
    expect(isMultiplexerEnv({ DVTM: "/tmp/dvtm" })).toBe(true);
    expect(isMultiplexerEnv({ TMUX: "" })).toBe(false);
    expect(isMultiplexerEnv({})).toBe(false);
    expect(isMultiplexerEnv({ TERM: "screen" })).toBe(false);
  });

  it("emits OSC 0 + OSC 2 (BEL-terminated) on plain terminals", () => {
    const seq = titleEscapeSequences("My Work", {});
    expect(seq).toBe("\x1b]0;My Work\x07\x1b]2;My Work\x07");
  });

  it("emits OSC 2 only under a multiplexer", () => {
    const seq = titleEscapeSequences("My Work", { TMUX: "/tmp/tmux-0/default,1,0" });
    expect(seq).toBe("\x1b]2;My Work\x07");
    expect(seq).not.toContain("\x1b]0;");
  });
});
