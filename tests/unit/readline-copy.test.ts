import { describe, it, expect } from "vitest";
import { copyPayloadForMessages } from "../../src/readline-copy.js";
import type { SessionMessage } from "../../src/session.js";

const msg = (role: SessionMessage["role"], content?: string | null): SessionMessage =>
  content === undefined ? { role } : { role, content };

describe("readline /copy payload decision (Issue #787)", () => {
  it("returns null when the session has no messages", () => {
    expect(copyPayloadForMessages([])).toBeNull();
  });

  it("returns null when only user/system/tool messages exist", () => {
    expect(
      copyPayloadForMessages([
        msg("system", "sys"),
        msg("user", "hello"),
        msg("tool", "tool output"),
      ]),
    ).toBeNull();
  });

  it("returns null when every assistant message lacks content", () => {
    expect(
      copyPayloadForMessages([
        msg("user", "hello"),
        msg("assistant", null),
        msg("assistant", ""),
        msg("assistant"),
      ]),
    ).toBeNull();
  });

  it("copies the last assistant response verbatim", () => {
    const response = "Hello from the stub provider.";
    expect(
      copyPayloadForMessages([msg("user", "hello"), msg("assistant", response)]),
    ).toBe(response);
    expect(
      copyPayloadForMessages([
        msg("user", "first"),
        msg("assistant", "first answer"),
        msg("user", "second"),
        msg("assistant", "second answer"),
      ]),
    ).toBe("second answer");
  });

  it("skips content-less assistant messages and keeps earlier real content", () => {
    expect(
      copyPayloadForMessages([
        msg("user", "hello"),
        msg("assistant", "real answer"),
        msg("assistant", null),
      ]),
    ).toBe("real answer");
  });

  it("copies an interrupted turn's preserved partial content (it is visible text)", () => {
    const partial: SessionMessage = { role: "assistant", content: "partial", interrupted: true };
    expect(copyPayloadForMessages([msg("user", "hello"), partial])).toBe("partial");
  });

  it("preserves multiline and unicode content verbatim", () => {
    const response = "line 1\nline 2 — 数据\ttabbed";
    expect(
      copyPayloadForMessages([msg("user", "hello"), msg("assistant", response)]),
    ).toBe(response);
  });
});
