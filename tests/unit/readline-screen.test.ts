import { describe, it, expect } from "vitest";
import {
  CLEAR_SCREEN_SEQUENCE,
  repairControlCharInsertion,
  wordKillBefore,
  lineKillBefore,
} from "../../src/readline-screen.js";

describe("readline control-char insertion repair (Issues #745/#747/#749/#751/#753)", () => {
  it("repairs a form feed inserted at the end of the line", () => {
    const snapshot = { line: "abc def", cursor: 7 };
    const repaired = repairControlCharInsertion(snapshot, { line: "abc def\f", cursor: 8 }, "\f");
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion mid-line and restores the cursor", () => {
    const snapshot = { line: "hello cursor here world", cursor: 17 };
    const repaired = repairControlCharInsertion(
      snapshot,
      { line: "hello cursor here\f world", cursor: 18 },
      "\f",
    );
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion at the start of the line", () => {
    const snapshot = { line: "draft text", cursor: 0 };
    const repaired = repairControlCharInsertion(snapshot, { line: "\fdraft text", cursor: 1 }, "\f");
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion into an empty line", () => {
    const snapshot = { line: "", cursor: 0 };
    const repaired = repairControlCharInsertion(snapshot, { line: "\f", cursor: 1 }, "\f");
    expect(repaired).toEqual(snapshot);
  });

  it("repairs the Ctrl+W byte (0x17) with the same verified shape", () => {
    const snapshot = { line: "hello world", cursor: 11 };
    const repaired = repairControlCharInsertion(
      snapshot,
      { line: "hello world\u0017", cursor: 12 },
      "\u0017",
    );
    expect(repaired).toEqual(snapshot);
  });

  it("repairs the Ctrl+U byte (0x15) with the same verified shape", () => {
    const snapshot = { line: "abc def", cursor: 7 };
    const repaired = repairControlCharInsertion(
      snapshot,
      { line: "abc def\u0015", cursor: 8 },
      "\u0015",
    );
    expect(repaired).toEqual(snapshot);
  });

  it("repairs the Ctrl+Z byte (0x1a) with the same verified shape", () => {
    const snapshot = { line: "cz probe line", cursor: 13 };
    const repaired = repairControlCharInsertion(
      snapshot,
      { line: "cz probe line\u001a", cursor: 14 },
      "\u001a",
    );
    expect(repaired).toEqual(snapshot);
  });

  it("repairs the Ctrl+A and Ctrl+E bytes (0x01/0x05) with the same verified shape", () => {
    // Under TERM=dumb these keystrokes have no effect beyond the pollution
    // (Node 24's readline is append-only there), so the repair IS the fix.
    const snapshot = { line: "alpha beta", cursor: 10 };
    expect(
      repairControlCharInsertion(snapshot, { line: "alpha beta\u0001", cursor: 11 }, "\u0001"),
    ).toEqual(snapshot);
    expect(
      repairControlCharInsertion(snapshot, { line: "alpha beta\u0005", cursor: 11 }, "\u0005"),
    ).toEqual(snapshot);
  });

  it("reports the state as-is when the byte never reached the buffer", () => {
    const snapshot = { line: "abc", cursor: 2 };
    expect(repairControlCharInsertion(snapshot, { line: "abc", cursor: 2 }, "\f")).toEqual(
      snapshot,
    );
    expect(repairControlCharInsertion(snapshot, { line: "abc", cursor: 2 }, "\u0017")).toEqual(
      snapshot,
    );
  });

  it("fails closed when reality diverges from the expected insertion", () => {
    const snapshot = { line: "abc", cursor: 1 };
    // Extra text appeared alongside the control char.
    expect(repairControlCharInsertion(snapshot, { line: "a\fbcx", cursor: 2 }, "\f")).toBeNull();
    // The cursor did not advance over the insertion.
    expect(repairControlCharInsertion(snapshot, { line: "a\fbc", cursor: 1 }, "\f")).toBeNull();
    // Two control chars — not the single keystroke's shape.
    expect(repairControlCharInsertion(snapshot, { line: "a\f\fbc", cursor: 2 }, "\f")).toBeNull();
    // An unrelated buffer (the line changed some other way).
    expect(repairControlCharInsertion(snapshot, { line: "xyz", cursor: 1 }, "\f")).toBeNull();
    // The wrong control char for the keystroke being repaired.
    expect(repairControlCharInsertion(snapshot, { line: "a\fbc", cursor: 2 }, "\u0017")).toBeNull();
  });

  it("is anchored at the snapshot cursor when the buffer already holds the char", () => {
    // The user's buffer already contained the char elsewhere (pasted content):
    // the repair is anchored at the tap-time cursor, so a genuine new
    // insertion is still repaired exactly and the pre-existing byte survives
    // in the restored state.
    const snapshot = { line: "a\fb", cursor: 3 };
    expect(
      repairControlCharInsertion(snapshot, { line: "a\fb\f", cursor: 4 }, "\f"),
    ).toEqual(snapshot);
    expect(repairControlCharInsertion(snapshot, { line: "a\fb", cursor: 3 }, "\f")).toEqual(
      snapshot,
    );
  });
});

describe("readline word-kill before the cursor (Issue #747)", () => {
  it("kills the trailing word at end of line", () => {
    expect(wordKillBefore({ line: "hello world", cursor: 11 })).toEqual({
      line: "hello ",
      cursor: 6,
    });
  });

  it("kills a whitespace run plus the word it trails in one press (bash default)", () => {
    // Cursor after a whitespace run: the run and the word it trails are one
    // kill ("hello   |" -> "").
    expect(wordKillBefore({ line: "hello   ", cursor: 8 })).toEqual({ line: "", cursor: 0 });
    // A single trailing space is part of the killed range, but the space
    // before the killed word survives (bash ground truth: "hello world |" +
    // C-w leaves "hello ").
    expect(wordKillBefore({ line: "hello world ", cursor: 12 })).toEqual({
      line: "hello ",
      cursor: 6,
    });
  });

  it("kills only the word before a mid-line cursor, keeping both sides intact", () => {
    expect(wordKillBefore({ line: "foo bar baz", cursor: 7 })).toEqual({
      line: "foo  baz",
      cursor: 4,
    });
  });

  it("kills to line start when no boundary exists", () => {
    expect(wordKillBefore({ line: "word", cursor: 4 })).toEqual({ line: "", cursor: 0 });
    // Mid-word cursor: kills the characters behind the cursor only (bash
    // ground truth: "word" with cursor after "wo" + C-w leaves "rd").
    expect(wordKillBefore({ line: "word", cursor: 2 })).toEqual({ line: "rd", cursor: 0 });
    // Leading whitespace is the boundary: only the chars behind the cursor
    // are killed; the rest of the word survives.
    expect(wordKillBefore({ line: "  abc", cursor: 3 })).toEqual({ line: "  bc", cursor: 2 });
  });

  it("is a no-op at line start and on an empty line", () => {
    expect(wordKillBefore({ line: "abc", cursor: 0 })).toEqual({ line: "abc", cursor: 0 });
    expect(wordKillBefore({ line: "", cursor: 0 })).toEqual({ line: "", cursor: 0 });
  });

  it("treats tabs as boundaries and never touches text after the cursor", () => {
    expect(wordKillBefore({ line: "one\ttwo", cursor: 7 })).toEqual({ line: "one\t", cursor: 4 });
    expect(wordKillBefore({ line: "keep tail", cursor: 4 })).toEqual({
      line: " tail",
      cursor: 0,
    });
  });
});

describe("readline line-kill before the cursor (Issue #749)", () => {
  it("kills the whole line when the cursor is at the end", () => {
    expect(lineKillBefore({ line: "abc def", cursor: 7 })).toEqual({ line: "", cursor: 0 });
  });

  it("keeps the tail verbatim when the cursor is mid-line", () => {
    expect(lineKillBefore({ line: "abc def", cursor: 3 })).toEqual({ line: " def", cursor: 0 });
    expect(lineKillBefore({ line: "abc def", cursor: 4 })).toEqual({ line: "def", cursor: 0 });
  });

  it("is a no-op at line start and on an empty line", () => {
    expect(lineKillBefore({ line: "abc", cursor: 0 })).toEqual({ line: "abc", cursor: 0 });
    expect(lineKillBefore({ line: "", cursor: 0 })).toEqual({ line: "", cursor: 0 });
  });
});

describe("clear-screen sequence (Issue #745)", () => {
  it("matches the /clear command convention (visible screen only)", () => {
    expect(CLEAR_SCREEN_SEQUENCE).toBe("\x1b[2J\x1b[H");
  });
});
