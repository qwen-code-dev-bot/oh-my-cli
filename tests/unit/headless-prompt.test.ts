import { describe, it, expect } from "vitest";
import { resolveHeadlessPromptSource, normalizeStdinPrompt } from "../../src/headless-prompt.js";

describe("headless prompt source resolution (Issue #759)", () => {
  it("uses the argument value when one is given", () => {
    expect(resolveHeadlessPromptSource("fix the bug", false)).toEqual({
      kind: "value",
      value: "fix the bug",
    });
    expect(resolveHeadlessPromptSource("fix the bug", true)).toEqual({
      kind: "value",
      value: "fix the bug",
    });
  });

  it("reads piped stdin when the flag stands alone without a TTY", () => {
    expect(resolveHeadlessPromptSource(true, false)).toEqual({ kind: "stdin" });
  });

  it("rejects a valueless flag on a TTY with one honest usage error", () => {
    const source = resolveHeadlessPromptSource(true, true);
    expect(source.kind).toBe("error");
    if (source.kind === "error") {
      expect(source.message).toContain("-p");
      expect(source.message).toContain("piped stdin");
    }
  });

  it("fails closed when the flag is absent entirely", () => {
    expect(resolveHeadlessPromptSource(undefined, false).kind).toBe("error");
    expect(resolveHeadlessPromptSource(undefined, true).kind).toBe("error");
  });
});

describe("stdin prompt normalization (Issue #759)", () => {
  it("keeps the piped text, trimming surrounding whitespace only", () => {
    expect(normalizeStdinPrompt("summarize this diff\n")).toBe("summarize this diff");
    expect(normalizeStdinPrompt("  padded  ")).toBe("padded");
    expect(normalizeStdinPrompt("no-trim-needed")).toBe("no-trim-needed");
  });

  it("keeps interior newlines and whitespace verbatim", () => {
    expect(normalizeStdinPrompt("line one\nline two\n")).toBe("line one\nline two");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(normalizeStdinPrompt("")).toBeNull();
    expect(normalizeStdinPrompt("\n\t  \n")).toBeNull();
  });
});
