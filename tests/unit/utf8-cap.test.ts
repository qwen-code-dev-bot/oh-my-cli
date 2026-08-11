import { describe, it, expect } from "vitest";
import {
  createCappedUtf8Decoder,
  type OutputByteCapState,
} from "../../src/utf8-cap.js";

// Coverage for the byte-capped streaming UTF-8 decoder (Issue #836). The hook,
// tool, and MCP output caps previously decoded each chunk with a standalone
// chunk.toString("utf8"), which corrupts a multi-byte character split across two
// chunks into U+FFFD. The decoder must reassemble split characters, honor the
// shared byte cap (#834), and keep the cut surrogate-safe (#830/#832).

function fresh(maxBytes: number): { state: OutputByteCapState; decode: (c: Buffer) => string } {
  const state: OutputByteCapState = { total: 0, capped: false };
  return { state, decode: createCappedUtf8Decoder(state, maxBytes) };
}

describe("createCappedUtf8Decoder: split-chunk reassembly (Issue #836)", () => {
  it("reassembles a multi-byte BMP character split across two chunks", () => {
    const { state, decode } = fresh(1000);
    const cjk = "你好世界"; // 4 chars, 3 UTF-8 bytes each
    const buf = Buffer.from(cjk, "utf8");
    // Split after 4 bytes: "你" (3 bytes) + 1 byte of "好".
    const text = decode(buf.subarray(0, 4)) + decode(buf.subarray(4));
    expect(text).toBe(cjk);
    expect(text).not.toContain("\ufffd");
    expect(state.capped).toBe(false);
  });

  it("reassembles a 4-byte astral character split across chunks", () => {
    const { decode } = fresh(1000);
    const emoji = "a🚀b"; // a(1) + 🚀(4) + b(1)
    const buf = Buffer.from(emoji, "utf8");
    // Split after 3 bytes: "a" + 2 bytes of 🚀.
    const text = decode(buf.subarray(0, 3)) + decode(buf.subarray(3));
    expect(text).toBe(emoji);
    expect(text).not.toContain("\ufffd");
  });

  it("returns empty for a chunk that contributes no complete character", () => {
    const { state, decode } = fresh(1000);
    // 0xE4 is the lead byte of 你 (E4 BD A0); alone it is incomplete.
    expect(decode(Buffer.from([0xe4]))).toBe("");
    expect(state.capped).toBe(false);
    expect(state.total).toBe(0);
    // The held byte reassembles with the rest.
    expect(decode(Buffer.from([0xbd, 0xa0]))).toBe("你");
  });

  it("passes pure-ASCII chunks through unchanged", () => {
    const { decode } = fresh(1000);
    expect(decode(Buffer.from("hello"))).toBe("hello");
    expect(decode(Buffer.from(" world"))).toBe(" world");
  });
});

describe("createCappedUtf8Decoder: byte cap (Issue #834 interplay)", () => {
  it("caps at the real byte budget for multi-byte text", () => {
    const { state, decode } = fresh(6); // 2 CJK chars
    const text = decode(Buffer.from("你好世界", "utf8")); // 12 bytes
    expect(state.capped).toBe(true);
    expect(text).toBe("你好");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(6);
  });

  it("never exceeds the budget nor orphans a surrogate across any budget", () => {
    const s = "ab你好🚀🚀cd";
    const total = Buffer.byteLength(s, "utf8");
    for (let maxBytes = 0; maxBytes <= total + 2; maxBytes++) {
      const { state, decode } = fresh(maxBytes);
      const out = decode(Buffer.from(s, "utf8"));
      expect(Buffer.byteLength(out, "utf8"), `max=${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      expect(out, `max=${maxBytes}`).not.toMatch(/[\ud800-\udbff]$/);
      if (maxBytes >= total) expect(state.capped, `max=${maxBytes}`).toBe(false);
    }
  });

  it("drops an astral char whole when the budget lands inside it", () => {
    const { state, decode } = fresh(3); // a(1) + 2 bytes of 🚀, not enough for the 4-byte char
    const text = decode(Buffer.from("a🚀", "utf8"));
    expect(state.capped).toBe(true);
    expect(text).toBe("a");
    expect(text).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("returns empty for every chunk after the cap is reached", () => {
    const { state, decode } = fresh(3);
    expect(decode(Buffer.from("你好", "utf8"))).toBe("你"); // 3 bytes
    expect(state.capped).toBe(true);
    expect(decode(Buffer.from("more output"))).toBe("");
  });

  it("shares one byte budget across multiple decoders (stdout+stderr)", () => {
    const state: OutputByteCapState = { total: 0, capped: false };
    const decodeOut = createCappedUtf8Decoder(state, 6);
    const decodeErr = createCappedUtf8Decoder(state, 6);
    const out = decodeOut(Buffer.from("abc", "utf8")); // 3 bytes
    expect(out).toBe("abc");
    expect(state.capped).toBe(false);
    // stderr consumes the remaining 3 bytes, then caps.
    const err = decodeErr(Buffer.from("defgh", "utf8")); // 5 bytes, only 3 fit
    expect(err).toBe("def");
    expect(state.capped).toBe(true);
    expect(decodeOut(Buffer.from("tail"))).toBe("");
  });
});
