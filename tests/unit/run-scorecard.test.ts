import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRunSummary } from "../../src/run-summary.js";
import type { RunSummary } from "../../src/run-summary.js";
import {
  parseRunSummary,
  readRunSummaryFile,
  parseScorecardThresholds,
  compareRunSummaries,
  formatScorecard,
  ScorecardInputError,
  DEFAULT_THRESHOLDS,
  RUN_SCORECARD_SCHEMA,
  RUN_SCORECARD_VERSION,
} from "../../src/run-scorecard.js";

// A valid RunSummary with sensible defaults; override per test.
function summary(over: Partial<Parameters<typeof buildRunSummary>[0]> = {}): RunSummary {
  return buildRunSummary({
    ok: true,
    exitCode: 0,
    reason: "completed",
    elapsedMs: 1000,
    rounds: 2,
    toolCalls: { read: 2, shell: 1 },
    toolFailures: {},
    tokens: { prompt: 5, completion: 5, total: 10 },
    sessionId: "sess",
    sessionPath: "~/.oh-my-cli/sessions/sess.jsonl",
    ...over,
  });
}

const tmpFiles: string[] = [];
function tmpFile(content: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scorecard-")), "summary.json");
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe("parseRunSummary", () => {
  it("parses a bare RunSummary JSON object", () => {
    const parsed = parseRunSummary(JSON.stringify(summary({ rounds: 4 })));
    expect(parsed.schema).toBe("oh-my-cli.summary");
    expect(parsed.rounds).toBe(4);
  });

  it("parses a pretty-printed bare RunSummary object", () => {
    const parsed = parseRunSummary(JSON.stringify(summary(), null, 2));
    expect(parsed.outcome).toBe("success");
  });

  it("extracts the summary event from a headless NDJSON stream", () => {
    const stream = [
      JSON.stringify({ type: "start", sessionId: "s", model: "m", prompt: "hi" }),
      JSON.stringify({ type: "summary", summary: summary({ rounds: 7 }) }),
      JSON.stringify({ type: "complete", ok: true, exitCode: 0, rounds: 7, reason: "completed" }),
    ].join("\n");
    const parsed = parseRunSummary(stream);
    expect(parsed.rounds).toBe(7);
  });

  it("uses the last summary when more than one is present", () => {
    const stream = [
      JSON.stringify({ type: "summary", summary: summary({ rounds: 1 }) }),
      JSON.stringify({ type: "summary", summary: summary({ rounds: 9 }) }),
    ].join("\n");
    expect(parseRunSummary(stream).rounds).toBe(9);
  });

  it("rejects empty input with an actionable message", () => {
    expect(() => parseRunSummary("   ", "baseline")).toThrow(ScorecardInputError);
    expect(() => parseRunSummary("", "baseline")).toThrow(/No run summary found in baseline/);
  });

  it("rejects input with no recognisable summary", () => {
    const stream = JSON.stringify({ type: "complete", ok: true, exitCode: 0 });
    expect(() => parseRunSummary(stream, "candidate")).toThrow(/No run summary found in candidate/);
  });

  it("rejects a version-incompatible summary with a clear verdict", () => {
    const v2 = { ...summary(), v: 2 };
    expect(() => parseRunSummary(JSON.stringify(v2), "baseline")).toThrow(
      /Incompatible run summary in baseline.*v1.*v2/s,
    );
  });

  it("rejects a wrong-schema summary carried in a summary event", () => {
    const event = JSON.stringify({ type: "summary", summary: { ...summary(), schema: "other.tool" } });
    expect(() => parseRunSummary(event, "candidate")).toThrow(/Incompatible run summary in candidate/);
  });

  it("rejects a structurally malformed summary and names the offending field", () => {
    const bad = { ...summary(), elapsedMs: "soon" };
    expect(() => parseRunSummary(JSON.stringify(bad), "baseline")).toThrow(
      /Malformed run summary in baseline.*elapsedMs/,
    );
  });

  it("rejects a summary missing a required field", () => {
    const bad: Record<string, unknown> = { ...summary() };
    delete bad.outcome;
    expect(() => parseRunSummary(JSON.stringify(bad))).toThrow(/Malformed run summary/);
  });
});

describe("readRunSummaryFile", () => {
  it("reads and parses a valid summary file", () => {
    const p = tmpFile(JSON.stringify(summary({ rounds: 3 })));
    expect(readRunSummaryFile(p, "baseline").rounds).toBe(3);
  });

  it("throws an actionable error for a missing file", () => {
    expect(() => readRunSummaryFile("/no/such/summary.json", "baseline")).toThrow(
      /Cannot read baseline summary: file not found/,
    );
  });
});

describe("parseScorecardThresholds", () => {
  it("parses valid thresholds", () => {
    expect(parseScorecardThresholds("0.5", "2")).toEqual({ elapsedRatio: 0.5, failureDelta: 2 });
  });

  it("rejects a negative or non-numeric elapsed ratio", () => {
    expect(() => parseScorecardThresholds("-0.1", "0")).toThrow(/Invalid --max-elapsed-ratio/);
    expect(() => parseScorecardThresholds("abc", "0")).toThrow(/Invalid --max-elapsed-ratio/);
  });

  it("rejects a negative or non-integer failure delta", () => {
    expect(() => parseScorecardThresholds("0.25", "-1")).toThrow(/Invalid --max-failure-delta/);
    expect(() => parseScorecardThresholds("0.25", "1.5")).toThrow(/Invalid --max-failure-delta/);
  });
});

describe("compareRunSummaries", () => {
  it("reports no regression for identical summaries", () => {
    const sc = compareRunSummaries(summary(), summary());
    expect(sc.schema).toBe(RUN_SCORECARD_SCHEMA);
    expect(sc.v).toBe(RUN_SCORECARD_VERSION);
    expect(sc.regression).toBe(false);
    expect(sc.outcomeRegressed).toBe(false);
    expect(sc.failuresRegressed).toBe(false);
    expect(sc.elapsedRegressed).toBe(false);
    for (const row of sc.rows) {
      expect(row.regression).toBe(false);
      expect(["same", "flat"]).toContain(row.change);
    }
  });

  it("emits rows in a fixed, deterministic order", () => {
    const sc = compareRunSummaries(summary(), summary());
    expect(sc.rows.map((r) => r.metric)).toEqual([
      "outcome",
      "reason",
      "elapsed ms",
      "rounds",
      "tool calls",
      "tool failures",
      "completed work",
      "tokens total",
    ]);
  });

  it("flags an outcome regression (success -> failure)", () => {
    const sc = compareRunSummaries(summary({ ok: true }), summary({ ok: false, reason: "error" }));
    expect(sc.outcomeRegressed).toBe(true);
    expect(sc.regression).toBe(true);
    const outcome = sc.rows.find((r) => r.metric === "outcome")!;
    expect(outcome.baseline).toBe("success");
    expect(outcome.candidate).toBe("failure");
    expect(outcome.change).toBe("changed");
    expect(outcome.regression).toBe(true);
  });

  it("does not flag failure -> success as a regression", () => {
    const sc = compareRunSummaries(summary({ ok: false }), summary({ ok: true }));
    expect(sc.outcomeRegressed).toBe(false);
  });

  it("flags a tool-failure increase beyond the default delta of 0", () => {
    const sc = compareRunSummaries(
      summary({ toolFailures: {} }),
      summary({ toolFailures: { shell: 2 } }),
    );
    expect(sc.failuresRegressed).toBe(true);
    expect(sc.regression).toBe(true);
    const row = sc.rows.find((r) => r.metric === "tool failures")!;
    expect(row.delta).toBe(2);
    expect(row.change).toBe("up");
    expect(row.regression).toBe(true);
  });

  it("honours a custom failure delta threshold", () => {
    const sc = compareRunSummaries(
      summary({ toolFailures: {} }),
      summary({ toolFailures: { shell: 2 } }),
      { ...DEFAULT_THRESHOLDS, failureDelta: 5 },
    );
    expect(sc.failuresRegressed).toBe(false);
    expect(sc.regression).toBe(false);
  });

  it("flags an elapsed slowdown beyond the default 25% ratio", () => {
    const sc = compareRunSummaries(summary({ elapsedMs: 1000 }), summary({ elapsedMs: 1500 }));
    expect(sc.elapsedRegressed).toBe(true);
    expect(sc.regression).toBe(true);
  });

  it("does not flag an elapsed increase within the ratio", () => {
    const sc = compareRunSummaries(summary({ elapsedMs: 1000 }), summary({ elapsedMs: 1200 }));
    expect(sc.elapsedRegressed).toBe(false);
    expect(sc.regression).toBe(false);
  });

  it("honours a custom elapsed ratio threshold", () => {
    const sc = compareRunSummaries(
      summary({ elapsedMs: 1000 }),
      summary({ elapsedMs: 1900 }),
      { ...DEFAULT_THRESHOLDS, elapsedRatio: 1.0 },
    );
    expect(sc.elapsedRegressed).toBe(false);
  });

  it("does not flag elapsed when the baseline took no time (avoids divide-by-zero)", () => {
    const sc = compareRunSummaries(summary({ elapsedMs: 0 }), summary({ elapsedMs: 5000 }));
    expect(sc.elapsedRegressed).toBe(false);
  });

  it("computes completed work as tool calls minus tool failures", () => {
    const sc = compareRunSummaries(
      summary({ toolCalls: { read: 3 }, toolFailures: {} }),
      summary({ toolCalls: { shell: 5 }, toolFailures: { shell: 2 } }),
    );
    const row = sc.rows.find((r) => r.metric === "completed work")!;
    expect(row.baseline).toBe(3);
    expect(row.candidate).toBe(3);
    expect(row.delta).toBe(0);
  });

  it("treats two n/a token reports as unchanged and a mixed report as changed", () => {
    const bothNull = compareRunSummaries(summary({ tokens: null }), summary({ tokens: null }));
    const rowA = bothNull.rows.find((r) => r.metric === "tokens total")!;
    expect(rowA.baseline).toBeNull();
    expect(rowA.candidate).toBeNull();
    expect(rowA.delta).toBeNull();
    expect(rowA.change).toBe("same");

    const mixed = compareRunSummaries(summary({ tokens: null }), summary());
    const rowB = mixed.rows.find((r) => r.metric === "tokens total")!;
    expect(rowB.change).toBe("changed");
    expect(rowB.delta).toBeNull();
  });

  it("echoes the thresholds used so the verdict is auditable", () => {
    const thresholds = { elapsedRatio: 0.75, failureDelta: 3 };
    expect(compareRunSummaries(summary(), summary(), thresholds).thresholds).toEqual(thresholds);
  });

  it("never carries session ids, paths, or secrets into the scorecard", () => {
    const baseline = summary({
      sessionId: "sess-SECRET-id",
      sessionPath: "~/.oh-my-cli/sessions/secret.jsonl",
    });
    const candidate = summary({
      ok: false,
      sessionId: "sess-OTHER-id",
      sessionPath: "/home/alice/private/leak.jsonl",
    });
    const sc = compareRunSummaries(baseline, candidate);
    const serialized = JSON.stringify(sc) + "\n" + formatScorecard(sc);
    expect(serialized).not.toContain("sess-SECRET-id");
    expect(serialized).not.toContain("sess-OTHER-id");
    expect(serialized).not.toContain("secret.jsonl");
    expect(serialized).not.toContain("/home/alice");
  });
});

describe("formatScorecard", () => {
  it("renders a clean run with a no-regression result", () => {
    const text = formatScorecard(compareRunSummaries(summary(), summary()));
    expect(text).toContain("Run scorecard (oh-my-cli.scorecard v1)");
    expect(text).toContain("outcome:");
    expect(text).toContain("thresholds:");
    expect(text).toContain("no regression detected (exit 0)");
    expect(text).not.toContain("[REGRESSION]");
  });

  it("tags regressions inline and lists which thresholds crossed", () => {
    const text = formatScorecard(
      compareRunSummaries(
        summary({ ok: true, toolFailures: {}, elapsedMs: 1000 }),
        summary({ ok: false, reason: "error", toolFailures: { shell: 3 }, elapsedMs: 2000 }),
      ),
    );
    expect(text).toContain("[REGRESSION]");
    expect(text).toContain("Result: REGRESSION (exit 1)");
    expect(text).toContain("outcome regressed (success -> failure)");
    expect(text).toContain("tool failures rose more than 0 above baseline");
    expect(text).toContain("elapsed time rose more than 25% above baseline");
  });

  it("shows a delta annotation for changed numeric metrics", () => {
    const text = formatScorecard(
      compareRunSummaries(summary({ rounds: 2 }), summary({ rounds: 5 })),
    );
    expect(text).toMatch(/rounds:\s+2 -> 5 \(\+3, up\)/);
  });
});
