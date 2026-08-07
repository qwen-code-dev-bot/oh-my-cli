import { describe, it, expect } from "vitest";
import { pastedTextToComposer } from "../../src/paste-transform.js";

describe("paste-transform: boundary preservation (Issue #733)", () => {
  it("preserves internal line boundaries", () => {
    expect(pastedTextToComposer("first line\nsecond line")).toBe("first line\nsecond line");
    expect(pastedTextToComposer("a\nb\nc")).toBe("a\nb\nc");
  });

  it("treats CRLF as one boundary", () => {
    expect(pastedTextToComposer("first line\r\nsecond line")).toBe("first line\nsecond line");
    expect(pastedTextToComposer("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("treats a lone CR as one boundary", () => {
    expect(pastedTextToComposer("a\rb")).toBe("a\nb");
  });

  it("strips leading and trailing paste-artifact boundaries", () => {
    expect(pastedTextToComposer("a\n")).toBe("a");
    expect(pastedTextToComposer("\na")).toBe("a");
    expect(pastedTextToComposer("a\nb\n")).toBe("a\nb");
    expect(pastedTextToComposer("\n\na\nb\n\n")).toBe("a\nb");
  });

  it("preserves intentional blank lines between content", () => {
    expect(pastedTextToComposer("a\n\nb")).toBe("a\n\nb");
    expect(pastedTextToComposer("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it("returns empty for terminator-only or control-only payloads", () => {
    expect(pastedTextToComposer("\n")).toBe("");
    expect(pastedTextToComposer("\r\n\r\n")).toBe("");
    expect(pastedTextToComposer("\u007f\u0001")).toBe("");
  });

  it("drops embedded control bytes but keeps boundaries and text", () => {
    expect(pastedTextToComposer("a\u0001b\nc\u007fd")).toBe("ab\ncd");
  });

  it("passes single-line text through unchanged", () => {
    expect(pastedTextToComposer("just one line")).toBe("just one line");
    expect(pastedTextToComposer("你好世界")).toBe("你好世界");
  });

  it("keeps UTF-8 content around boundaries intact (Issue #731 reassembly upstream)", () => {
    expect(pastedTextToComposer("错误一\n错误二")).toBe("错误一\n错误二");
    expect(pastedTextToComposer("😀\n🚀")).toBe("😀\n🚀");
  });
});
