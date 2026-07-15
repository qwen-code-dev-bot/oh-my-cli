import { describe, it, expect } from "vitest";
import {
  HEADLESS_PROTOCOL,
  HEADLESS_VERSION,
  HeadlessWriter,
  createHeadlessSink,
  startEvent,
  parseHeadlessLine,
  parseHeadlessStream,
  terminalRecord,
} from "../../src/headless-protocol.js";
import type { HeadlessRecord } from "../../src/headless-protocol.js";

class FakeOut {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  raw(): string {
    return this.chunks.join("");
  }
  records(): HeadlessRecord[] {
    return parseHeadlessStream(this.raw());
  }
}

// A GitHub-token-shaped secret that redactSecrets is known to catch.
const SECRET = ["ghp", "_", "a".repeat(24)].join("");

describe("HeadlessWriter", () => {
  it("stamps every record with the protocol envelope", () => {
    const out = new FakeOut();
    const w = new HeadlessWriter(out, () => 1_700_000_000_000);
    w.emit({ type: "start", sessionId: "s1", model: "m", prompt: "hi" });

    const line = out.raw().trim();
    const rec = JSON.parse(line);
    expect(rec.protocol).toBe(HEADLESS_PROTOCOL);
    expect(rec.v).toBe(HEADLESS_VERSION);
    expect(rec.seq).toBe(0);
    expect(rec.ts).toBe(new Date(1_700_000_000_000).toISOString());
    expect(rec.type).toBe("start");
  });

  it("writes one JSON object per line (NDJSON) with monotonic seq", () => {
    const out = new FakeOut();
    const w = new HeadlessWriter(out);
    w.emit({ type: "start", sessionId: "s", model: "m", prompt: "p" });
    w.emit({ type: "assistant", round: 0, final: true, text: "ok", truncated: false });
    w.emit({ type: "complete", ok: true, exitCode: 0, rounds: 1, reason: "completed" });

    const lines = out.raw().split("\n");
    expect(lines[lines.length - 1]).toBe(""); // trailing newline
    const body = lines.slice(0, -1);
    expect(body.length).toBe(3);
    body.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
    expect(out.records().map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe("createHeadlessSink: schema for every event", () => {
  it("emits a start record via startEvent with redacted, bounded fields", () => {
    const ev = startEvent({ sessionId: "abc", model: "fake-model", prompt: `tell me ${SECRET}` });
    expect(ev.type).toBe("start");
    if (ev.type !== "start") throw new Error("unreachable");
    expect(ev.sessionId).toBe("abc");
    expect(ev.model).toBe("fake-model");
    expect(ev.prompt).not.toContain(SECRET);
    expect(ev.prompt).toContain("[REDACTED]");
  });

  it("emits an assistant record per turn and skips empty turns", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.assistantTurn("", 0, { final: false }); // empty → nothing
    sink.assistantTurn("hello", 1, { final: true });
    const recs = out.records();
    expect(recs.length).toBe(1);
    const a = recs[0];
    expect(a.type).toBe("assistant");
    if (a.type !== "assistant") throw new Error("unreachable");
    expect(a.round).toBe(1);
    expect(a.final).toBe(true);
    expect(a.text).toBe("hello");
    expect(a.truncated).toBe(false);
  });

  it("redacts secrets in assistant text", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.assistantTurn(`key is ${SECRET}`, 0, { final: true });
    const a = out.records()[0];
    expect(a.type).toBe("assistant");
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(JSON.stringify(a)).toContain("[REDACTED]");
  });

  it("truncates oversized assistant text and flags it", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.assistantTurn("x".repeat(40_000), 0, { final: true });
    const a = out.records()[0];
    if (a.type !== "assistant") throw new Error("unreachable");
    expect(a.truncated).toBe(true);
    expect(a.text.length).toBe(32_768);
  });

  it("emits matching tool_start and tool_result records", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.toolStart({ id: "c1", name: "read", round: 2 });
    sink.toolResult({ id: "c1", name: "read", result: { content: "file body" }, round: 2 });
    const [start, result] = out.records();
    expect(start.type).toBe("tool_start");
    if (start.type === "tool_start") {
      expect(start.id).toBe("c1");
      expect(start.name).toBe("read");
      expect(start.round).toBe(2);
    }
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.id).toBe("c1");
      expect(result.ok).toBe(true);
      expect(result.content).toBe("file body");
      expect(result.truncated).toBe(false);
      expect(result.bytes).toBe(Buffer.byteLength("file body"));
    }
  });

  it("marks a failed tool result with ok=false", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.toolResult({ id: "c2", name: "shell", result: { content: "boom", isError: true }, round: 0 });
    const r = out.records()[0];
    if (r.type !== "tool_result") throw new Error("unreachable");
    expect(r.ok).toBe(false);
    expect(r.content).toBe("boom");
  });

  it("redacts and truncates tool result content", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.toolResult({
      id: "c3",
      name: "shell",
      result: { content: `${SECRET} ` + "y".repeat(20_000) },
      round: 0,
    });
    const r = out.records()[0];
    if (r.type !== "tool_result") throw new Error("unreachable");
    expect(r.content).not.toContain(SECRET);
    expect(r.truncated).toBe(true);
    // bytes reflects the full redacted size, not the truncated slice.
    expect(r.bytes).toBeGreaterThan(r.content.length);
  });

  it("emits an error record for provider failures", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.providerError(`bad key ${SECRET}`);
    const e = out.records()[0];
    expect(e.type).toBe("error");
    if (e.type !== "error") throw new Error("unreachable");
    expect(e.stage).toBe("provider");
    expect(e.message).not.toContain(SECRET);
  });

  it("ignores assistant deltas (aggregated per turn instead)", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.assistantDelta("h");
    sink.assistantDelta("i");
    expect(out.records().length).toBe(0);
  });
});

describe("parseHeadlessLine (strict)", () => {
  const validLine = JSON.stringify({
    protocol: HEADLESS_PROTOCOL,
    v: HEADLESS_VERSION,
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    type: "complete",
    ok: true,
    exitCode: 0,
    rounds: 1,
    reason: "completed",
  });

  it("parses a valid record", () => {
    const rec = parseHeadlessLine(validLine);
    expect(rec.type).toBe("complete");
  });

  it("rejects an empty line", () => {
    expect(() => parseHeadlessLine("   ")).toThrow(/empty/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseHeadlessLine("{not json}")).toThrow(/valid JSON/);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseHeadlessLine("42")).toThrow(/not an object/);
  });

  it("rejects an unknown protocol", () => {
    const bad = JSON.stringify({ protocol: "other", v: 1, seq: 0, ts: "t", type: "start" });
    expect(() => parseHeadlessLine(bad)).toThrow(/unknown protocol/);
  });

  it("rejects an unsupported version", () => {
    const bad = JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: 99, seq: 0, ts: "t", type: "start" });
    expect(() => parseHeadlessLine(bad)).toThrow(/unsupported version/);
  });

  it("rejects a non-integer or negative seq", () => {
    const f = JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: -1, ts: "t", type: "start" });
    expect(() => parseHeadlessLine(f)).toThrow(/seq/);
    const g = JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: "0", ts: "t", type: "start" });
    expect(() => parseHeadlessLine(g)).toThrow(/seq/);
  });

  it("rejects a missing ts or type", () => {
    const noTs = JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, type: "start" });
    expect(() => parseHeadlessLine(noTs)).toThrow(/ts/);
    const noType = JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, ts: "t" });
    expect(() => parseHeadlessLine(noType)).toThrow(/type/);
  });
});

describe("parseHeadlessStream and terminalRecord", () => {
  it("parses every line independently and ignores blank lines", () => {
    const text = [
      JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, ts: "t", type: "start", sessionId: "s", model: "m", prompt: "p" }),
      "",
      JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 1, ts: "t", type: "complete", ok: false, exitCode: 1, rounds: 0, reason: "provider_error" }),
      "",
    ].join("\n");
    const recs = parseHeadlessStream(text);
    expect(recs.length).toBe(2);
    expect(recs.map((r) => r.type)).toEqual(["start", "complete"]);
  });

  it("throws if any single line is malformed (independent parseability)", () => {
    const text = [
      JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, ts: "t", type: "start", sessionId: "s", model: "m", prompt: "p" }),
      "{broken}",
    ].join("\n");
    expect(() => parseHeadlessStream(text)).toThrow();
  });

  it("returns the last complete record as the terminal record", () => {
    const recs = parseHeadlessStream(
      [
        JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, ts: "t", type: "start", sessionId: "s", model: "m", prompt: "p" }),
        JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 1, ts: "t", type: "complete", ok: true, exitCode: 0, rounds: 2, reason: "completed" }),
      ].join("\n"),
    );
    const term = terminalRecord(recs);
    expect(term).not.toBeNull();
    expect(term!.type).toBe("complete");
    if (term && term.type === "complete") {
      expect(term.ok).toBe(true);
      expect(term.exitCode).toBe(0);
    }
  });

  it("returns null when there is no complete record", () => {
    const recs = parseHeadlessStream(
      JSON.stringify({ protocol: HEADLESS_PROTOCOL, v: HEADLESS_VERSION, seq: 0, ts: "t", type: "start", sessionId: "s", model: "m", prompt: "p" }),
    );
    expect(terminalRecord(recs)).toBeNull();
  });
});
