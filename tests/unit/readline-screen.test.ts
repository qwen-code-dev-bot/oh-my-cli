import { describe, it, expect } from "vitest";
import { CLEAR_SCREEN_SEQUENCE, repairCtrlLInsertion } from "../../src/readline-screen.js";

describe("readline Ctrl+L repair (Issue #745)", () => {
  it("repairs a form feed inserted at the end of the line", () => {
    const snapshot = { line: "abc def", cursor: 7 };
    const repaired = repairCtrlLInsertion(snapshot, { line: "abc def\f", cursor: 8 });
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion mid-line and restores the cursor", () => {
    const snapshot = { line: "hello cursor here world", cursor: 17 };
    const repaired = repairCtrlLInsertion(snapshot, {
      line: "hello cursor here\f world",
      cursor: 18,
    });
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion at the start of the line", () => {
    const snapshot = { line: "draft text", cursor: 0 };
    const repaired = repairCtrlLInsertion(snapshot, { line: "\fdraft text", cursor: 1 });
    expect(repaired).toEqual(snapshot);
  });

  it("repairs an insertion into an empty line", () => {
    const snapshot = { line: "", cursor: 0 };
    const repaired = repairCtrlLInsertion(snapshot, { line: "\f", cursor: 1 });
    expect(repaired).toEqual(snapshot);
  });

  it("reports the state as-is when the byte never reached the buffer", () => {
    const snapshot = { line: "abc", cursor: 2 };
    expect(repairCtrlLInsertion(snapshot, { line: "abc", cursor: 2 })).toEqual(snapshot);
  });

  it("fails closed when reality diverges from the expected insertion", () => {
    const snapshot = { line: "abc", cursor: 1 };
    // Extra text appeared alongside the form feed.
    expect(repairCtrlLInsertion(snapshot, { line: "a\fbcx", cursor: 2 })).toBeNull();
    // The cursor did not advance over the insertion.
    expect(repairCtrlLInsertion(snapshot, { line: "a\fbc", cursor: 1 })).toBeNull();
    // Two form feeds — not the single keystroke's shape.
    expect(repairCtrlLInsertion(snapshot, { line: "a\f\fbc", cursor: 2 })).toBeNull();
    // An unrelated buffer (the line changed some other way).
    expect(repairCtrlLInsertion(snapshot, { line: "xyz", cursor: 1 })).toBeNull();
  });

  it("is anchored at the snapshot cursor when the buffer already holds a form feed", () => {
    // The user's buffer already contained a form feed elsewhere (pasted
    // content): the repair is anchored at the tap-time cursor, so a genuine
    // new insertion is still repaired exactly and the pre-existing byte
    // survives in the restored state.
    const snapshot = { line: "a\fb", cursor: 3 };
    expect(repairCtrlLInsertion(snapshot, { line: "a\fb\f", cursor: 4 })).toEqual(snapshot);
    expect(repairCtrlLInsertion(snapshot, { line: "a\fb", cursor: 3 })).toEqual(snapshot);
  });
});

describe("clear-screen sequence (Issue #745)", () => {
  it("matches the /clear command convention (visible screen only)", () => {
    expect(CLEAR_SCREEN_SEQUENCE).toBe("\x1b[2J\x1b[H");
  });
});
