import { describe, it, expect } from "vitest";
import { decodeUtf8Streaming, hasNonAscii } from "../../src/utf8-chunks.js";

const B = (s: string) => Buffer.from(s, "utf-8");

// Thread chunks through the stateful decoder the way the shell does.
function stream(chunks: Buffer[]): { text: string; pending: Buffer } {
  let pending = Buffer.alloc(0);
  let text = "";
  for (const chunk of chunks) {
    const out = decodeUtf8Streaming(pending, chunk);
    text += out.text;
    pending = out.pending;
  }
  return { text, pending };
}

describe("utf8-chunks: complete delivery (Issue #731)", () => {
  it("passes ASCII through byte-identically with nothing pending", () => {
    const out = decodeUtf8Streaming(Buffer.alloc(0), B("hello /status\r"));
    expect(out.text).toBe("hello /status\r");
    expect(out.pending).toHaveLength(0);
  });

  it("decodes complete 2-, 3-, and 4-byte characters in one chunk", () => {
    expect(decodeUtf8Streaming(Buffer.alloc(0), B("é")).text).toBe("é");
    expect(decodeUtf8Streaming(Buffer.alloc(0), B("你好世界")).text).toBe("你好世界");
    expect(decodeUtf8Streaming(Buffer.alloc(0), B("😀🚀")).text).toBe("😀🚀");
  });

  it("keeps control bytes intact for the escape/key dispatch", () => {
    const out = decodeUtf8Streaming(Buffer.alloc(0), Buffer.from([0x1b, 0x5b, 0x41])); // ESC [ A
    expect(out.text).toBe("\x1b[A");
    expect(out.pending).toHaveLength(0);
  });
});

describe("utf8-chunks: split delivery reassembles intact (Issue #731)", () => {
  it("reassembles a 3-byte character at every split offset", () => {
    const ni = B("你"); // e4 bd a0
    expect(stream([ni.subarray(0, 1), ni.subarray(1)]).text).toBe("你");
    expect(stream([ni.subarray(0, 2), ni.subarray(2)]).text).toBe("你");
  });

  it("reassembles a 2-byte character split after the lead", () => {
    const e = B("é"); // c3 a9
    expect(stream([e.subarray(0, 1), e.subarray(1)]).text).toBe("é");
  });

  it("reassembles a 4-byte character at every split offset", () => {
    const emoji = B("😀"); // f0 9f 98 80
    for (let cut = 1; cut <= 3; cut++) {
      expect(stream([emoji.subarray(0, cut), emoji.subarray(cut)]).text).toBe("😀");
    }
  });

  it("reassembles byte-at-a-time delivery", () => {
    const bytes = [...B("你好")].map((b) => Buffer.from([b]));
    expect(stream(bytes).text).toBe("你好");
  });

  it("holds the incomplete tail until the next chunk", () => {
    const ni = B("你");
    const first = decodeUtf8Streaming(Buffer.alloc(0), ni.subarray(0, 2));
    expect(first.text).toBe("");
    expect(first.pending).toEqual(Buffer.from([0xe4, 0xbd]));
    const second = decodeUtf8Streaming(first.pending, ni.subarray(2));
    expect(second.text).toBe("你");
    expect(second.pending).toHaveLength(0);
  });

  it("interleaves ASCII around split sequences without loss", () => {
    // "a" + E4 | BD A0 + "b"
    const chunks = [B("a"), Buffer.from([0xe4]), Buffer.concat([Buffer.from([0xbd, 0xa0]), B("b")])];
    expect(stream(chunks).text).toBe("a你b");
  });
});

describe("utf8-chunks: invalid bytes fail closed (Issue #731)", () => {
  it("drops an invalid lead byte instead of emitting U+FFFD", () => {
    const out = decodeUtf8Streaming(Buffer.alloc(0), Buffer.from([0xff, 0x61]));
    expect(out.text).toBe("a");
    expect(out.text).not.toContain("\uFFFD");
  });

  it("drops lone continuation bytes", () => {
    const out = decodeUtf8Streaming(Buffer.alloc(0), Buffer.from([0x80, 0x62]));
    expect(out.text).toBe("b");
    expect(out.text).not.toContain("\uFFFD");
  });

  it("drops an overlong lead (C0) instead of holding it", () => {
    const out = decodeUtf8Streaming(Buffer.alloc(0), Buffer.from([0xc0, 0x63]));
    expect(out.text).toBe("c");
    expect(out.pending).toHaveLength(0);
  });

  it("drops a broken cluster lead but keeps the following valid byte", () => {
    // E4 expects two continuation bytes; "(" (0x28) is not one.
    const out = decodeUtf8Streaming(Buffer.alloc(0), Buffer.from([0xe4, 0x28]));
    expect(out.text).toBe("(");
    expect(out.text).not.toContain("\uFFFD");
  });

  it("discards stale pending bytes superseded by a new valid sequence", () => {
    // Pending E4 (from a dropped split) followed by a complete fresh 你:
    // the orphan lead is discarded, never concatenated into the new char.
    const out = decodeUtf8Streaming(Buffer.from([0xe4]), B("你"));
    expect(out.text).toBe("你");
    expect(out.text).not.toContain("\uFFFD");
  });

  it("turns a pending sequence into nothing when followed by Enter", () => {
    // An incomplete char abandoned before Enter must not swallow the Enter.
    const out = decodeUtf8Streaming(Buffer.from([0xe4, 0xbd]), Buffer.from([0x0d]));
    expect(out.text).toBe("\r");
    expect(out.pending).toHaveLength(0);
  });
});

describe("utf8-chunks: fast-path guard", () => {
  it("detects non-ASCII content", () => {
    expect(hasNonAscii(B("abc"))).toBe(false);
    expect(hasNonAscii(Buffer.from([0x1b, 0x5b, 0x41]))).toBe(false);
    expect(hasNonAscii(B("你"))).toBe(true);
    expect(hasNonAscii(Buffer.from([0x61, 0x80]))).toBe(true);
    expect(hasNonAscii(Buffer.alloc(0))).toBe(false);
  });
});
