import { describe, it, expect } from "vitest";
import { isMultilinePasteChunk, flattenPastedChunk } from "../../src/readline-paste.js";

const b = (s: string) => Buffer.from(s, "utf8");

describe("readline paste detection (Issue #727)", () => {
  it("flags a chunk with content after the first terminator as a paste", () => {
    // The reproduced hazard: a two-line paste arrives as one chunk with one
    // internal terminator and content following it.
    expect(isMultilinePasteChunk(b("first line\nsecond line"))).toBe(true);
    expect(isMultilinePasteChunk(b("a\r\nb\r\nc"))).toBe(true);
    expect(isMultilinePasteChunk(b("a\rb\r"))).toBe(true);
    expect(isMultilinePasteChunk(b("one\ntwo\n"))).toBe(true);
    expect(isMultilinePasteChunk(b("line1\nline2\nline3"))).toBe(true);
  });

  it("treats terminator-only tails as typing, not paste", () => {
    expect(isMultilinePasteChunk(b("typed line\r\n"))).toBe(false);
    expect(isMultilinePasteChunk(b("typed line\n"))).toBe(false);
    expect(isMultilinePasteChunk(b("typed line\r"))).toBe(false);
    // Coalesced double-Enter: no content after the first terminator, so the
    // submit semantics of a fast double-Enter are preserved.
    expect(isMultilinePasteChunk(b("hi\r\r"))).toBe(false);
    expect(isMultilinePasteChunk(b("a\n\n"))).toBe(false);
  });

  it("does not flag ordinary typed input", () => {
    expect(isMultilinePasteChunk(b(""))).toBe(false);
    expect(isMultilinePasteChunk(b("hello"))).toBe(false);
    expect(isMultilinePasteChunk(b("hello world"))).toBe(false);
    expect(isMultilinePasteChunk(b("/status"))).toBe(false);
  });

  it("flags bracketed-paste markers even with one line", () => {
    expect(isMultilinePasteChunk(b("\x1b[200~pasted\x1b[201~"))).toBe(true);
    expect(isMultilinePasteChunk(b("\x1b[200~only one line\x1b[201~"))).toBe(true);
  });
});

describe("readline paste flattening (Issue #727)", () => {
  it("joins lines in order with single spaces", () => {
    expect(flattenPastedChunk(b("first pasted line\nsecond pasted line"))).toBe(
      "first pasted line second pasted line",
    );
    expect(flattenPastedChunk(b("a\r\nb\r\nc"))).toBe("a b c");
  });

  it("drops blank lines and trims each line", () => {
    expect(flattenPastedChunk(b("  one  \n\n   \ntwo\n"))).toBe("one two");
  });

  it("strips bracketed-paste markers", () => {
    expect(flattenPastedChunk(b("\x1b[200~error trace\x1b[201~"))).toBe("error trace");
    expect(flattenPastedChunk(b("\x1b[200~line one\nline two\x1b[201~"))).toBe(
      "line one line two",
    );
  });

  it("returns empty for marker-only or whitespace-only payloads", () => {
    expect(flattenPastedChunk(b("\x1b[200~\x1b[201~"))).toBe("");
    expect(flattenPastedChunk(b("   \n  \n"))).toBe("");
  });
});
