import { describe, it, expect } from "vitest";
import {
  buildRunSummary,
  formatRunSummary,
  RUN_SUMMARY_SCHEMA,
  RUN_SUMMARY_VERSION,
} from "../../src/run-summary.js";

describe("buildRunSummary", () => {
  it("builds a deterministic success summary with bounded activity and tokens", () => {
    const s = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: 1234,
      rounds: 2,
      toolCalls: { read: 2, shell: 1 },
      toolFailures: {},
      tokens: { prompt: 10, completion: 6, total: 16 },
      sessionId: "abc-123",
      sessionPath: "~/.oh-my-cli/sessions/abc-123.jsonl",
    });

    expect(s.schema).toBe(RUN_SUMMARY_SCHEMA);
    expect(s.v).toBe(RUN_SUMMARY_VERSION);
    expect(s.outcome).toBe("success");
    expect(s.exitCode).toBe(0);
    expect(s.reason).toBe("completed");
    expect(s.elapsedMs).toBe(1234);
    expect(s.rounds).toBe(2);
    expect(s.toolCalls.total).toBe(3);
    expect(s.toolCalls.byName).toEqual({ read: 2, shell: 1 });
    expect(s.toolFailures.total).toBe(0);
    expect(s.toolFailures.byName).toEqual({});
    expect(s.tokens).toEqual({ prompt: 10, completion: 6, total: 16 });
    expect(s.evidence.sessionId).toBe("abc-123");
    expect(s.evidence.sessionPath).toBe("~/.oh-my-cli/sessions/abc-123.jsonl");
  });

  it("classifies a failing run with the same schema and a terminal reason", () => {
    const s = buildRunSummary({
      ok: false,
      exitCode: 1,
      reason: "max_rounds",
      elapsedMs: 500,
      rounds: 30,
      toolCalls: { shell: 30 },
      toolFailures: { shell: 2 },
      tokens: null,
      sessionId: "xyz",
      sessionPath: null,
    });

    expect(s.outcome).toBe("failure");
    expect(s.exitCode).toBe(1);
    expect(s.reason).toBe("max_rounds");
    expect(s.toolFailures.total).toBe(2);
    expect(s.toolFailures.byName).toEqual({ shell: 2 });
    expect(s.tokens).toBeNull();
    expect(s.evidence.sessionPath).toBeNull();
  });

  it("rolls overflow tool names into a single __other__ bucket (bounded cardinality)", () => {
    const toolCalls: Record<string, number> = {};
    for (let i = 0; i < 20; i++) toolCalls[`tool${String(i).padStart(2, "0")}`] = 1;
    const s = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: 1,
      rounds: 1,
      toolCalls,
      toolFailures: {},
      tokens: null,
      sessionId: "s",
      sessionPath: null,
    });

    // Total counts every call; distinct names are capped at 16 plus __other__.
    expect(s.toolCalls.total).toBe(20);
    const names = Object.keys(s.toolCalls.byName);
    expect(names).toContain("__other__");
    expect(names.length).toBe(17);
    expect(s.toolCalls.byName["__other__"]).toBe(4);
  });

  it("clamps negative elapsed/rounds and drops non-positive counts", () => {
    const s = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: -5,
      rounds: -1,
      toolCalls: { read: 0, write: -3, shell: 2 },
      toolFailures: {},
      tokens: { prompt: -1, completion: 2, total: 1 },
      sessionId: "s",
      sessionPath: null,
    });

    expect(s.elapsedMs).toBe(0);
    expect(s.rounds).toBe(0);
    expect(s.toolCalls.total).toBe(2);
    expect(s.toolCalls.byName).toEqual({ shell: 2 });
    expect(s.tokens).toEqual({ prompt: 0, completion: 2, total: 1 });
  });
});

describe("formatRunSummary", () => {
  it("renders only metadata fields in a stable order", () => {
    const text = formatRunSummary(
      buildRunSummary({
        ok: true,
        exitCode: 0,
        reason: "completed",
        elapsedMs: 2000,
        rounds: 1,
        toolCalls: { read: 1 },
        toolFailures: {},
        tokens: { prompt: 5, completion: 5, total: 10 },
        sessionId: "sess-1",
        sessionPath: "~/.oh-my-cli/sessions/sess-1.jsonl",
      }),
    );

    expect(text).toContain("Run summary (oh-my-cli.summary v1)");
    expect(text).toContain("outcome:   success");
    expect(text).toContain("elapsed:   2.0s");
    expect(text).toContain("tool calls: 1 (read×1)");
    expect(text).toContain("tokens:    prompt 5, completion 5, total 10");
    expect(text).toContain("evidence:  session sess-1 (~/.oh-my-cli/sessions/sess-1.jsonl)");
  });

  it("shows n/a tokens and a session-only evidence line when path is absent", () => {
    const text = formatRunSummary(
      buildRunSummary({
        ok: false,
        exitCode: 1,
        reason: "provider_error",
        elapsedMs: 10,
        rounds: 0,
        toolCalls: {},
        toolFailures: {},
        tokens: null,
        sessionId: "sess-2",
        sessionPath: null,
      }),
    );

    expect(text).toContain("tokens:    n/a");
    expect(text).toContain("evidence:  session sess-2");
    expect(text).not.toContain(" (~");
  });

  it("never emits secret-shaped content even if a session id contained one", () => {
    // The summary only carries metadata; this guards the formatter contract.
    const text = formatRunSummary(
      buildRunSummary({
        ok: true,
        exitCode: 0,
        reason: "completed",
        elapsedMs: 1,
        rounds: 1,
        toolCalls: { shell: 1 },
        toolFailures: {},
        tokens: null,
        sessionId: "sess-3",
        sessionPath: "~/.oh-my-cli/sessions/sess-3.jsonl",
      }),
    );
    expect(text).not.toMatch(/password|secret|sk-/i);
  });
});
