import { describe, it, expect } from "vitest";
import {
  ORIENTATION_EXCERPT_CHARS,
  excerptOneLine,
  readlineOrientationLine,
} from "../../src/readline-orientation.js";

describe("readline orientation: excerpt bounding (Issue #737)", () => {
  it("passes short single-line text through unchanged", () => {
    expect(excerptOneLine("fix the build")).toBe("fix the build");
  });

  it("flattens multi-line prompts to one line", () => {
    expect(excerptOneLine("first line\nsecond   line")).toBe("first line second line");
    expect(excerptOneLine("  spaced\tout\n")).toBe("spaced out");
  });

  it("bounds long excerpts with a single trailing ellipsis", () => {
    const long = "word ".repeat(60).trim(); // ~300 chars
    const out = excerptOneLine(long);
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_EXCERPT_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("keeps exactly-max-length text without an ellipsis", () => {
    const exact = "x".repeat(ORIENTATION_EXCERPT_CHARS);
    expect(excerptOneLine(exact)).toBe(exact);
  });
});

describe("readline orientation: line builder (Issue #737)", () => {
  it("reports an empty resumed session honestly", () => {
    expect(readlineOrientationLine([])).toBe("Resumed session: no messages yet");
  });

  it("reports sessions without user prompts honestly", () => {
    const line = readlineOrientationLine([
      { role: "system", content: "sys" },
      { role: "assistant", content: "hello" },
    ]);
    expect(line).toBe("Resumed session: 2 messages · no user prompts yet");
  });

  it("skips empty and non-string user contents", () => {
    const line = readlineOrientationLine([
      { role: "user", content: "real prompt" },
      { role: "user", content: "   " },
      { role: "user" },
    ]);
    expect(line).toBe('Resumed session: 3 messages · last: "real prompt"');
  });

  it("shows the LAST user prompt and the full message count", () => {
    const line = readlineOrientationLine([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]);
    expect(line).toBe('Resumed session: 4 messages · last: "latest question"');
  });

  it("flattens and bounds multi-line last prompts", () => {
    const multi = "line one\nline two\n" + "x".repeat(200);
    const line = readlineOrientationLine([{ role: "user", content: multi }]);
    expect(line.startsWith("Resumed session: 1 message · last: \"")).toBe(true);
    expect(line.endsWith("…\"")).toBe(true);
    const excerpt = line.slice("Resumed session: 1 message · last: \"".length, -2);
    expect(excerpt.length).toBeLessThanOrEqual(ORIENTATION_EXCERPT_CHARS);
    expect(excerpt).toContain("line one line two");
  });
});
