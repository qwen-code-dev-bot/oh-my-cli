import { describe, it, expect } from "vitest";
import {
  buildSessionStats,
  formatSessionStats,
  SESSION_STATS_SCHEMA,
  SESSION_STATS_VERSION,
} from "../../src/session-stats.js";
import type { SessionStatsRuntime } from "../../src/session-stats.js";
import type { SessionMessage } from "../../src/session.js";

function call(name: string): NonNullable<SessionMessage["tool_calls"]>[number] {
  return { id: `c-${name}-${Math.random()}`, type: "function", function: { name, arguments: "{}" } };
}

function transcript(): SessionMessage[] {
  return [
    { role: "user", content: "please inspect the build" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [call("read_file"), call("read_file"), call("grep")],
    },
    { role: "tool", content: "file contents", tool_call_id: "x" },
    { role: "tool", content: "matches", tool_call_id: "y" },
    { role: "assistant", content: "the build is fine" },
  ];
}

describe("buildSessionStats — deterministic log aggregation", () => {
  it("counts messages, turns, and tool calls by name from the canonical log", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript() });
    expect(stats.activity.messages).toBe(5);
    expect(stats.activity.userTurns).toBe(1);
    expect(stats.activity.assistantTurns).toBe(2);
    expect(stats.tools.calls.total).toBe(3);
    expect(stats.tools.calls.byName).toEqual({ read_file: 2, grep: 1 });
    expect(stats.tools.calls.kind).toBe("measured");
  });

  it("reports an empty session as zeros with an estimate context of 0", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: [] });
    expect(stats.activity).toEqual({ messages: 0, userTurns: 0, assistantTurns: 0 });
    expect(stats.context.chars).toBe(0);
    expect(stats.context.tokens).toEqual({ kind: "estimate", value: 0 });
    expect(stats.tools.calls.total).toBe(0);
  });

  it("is deterministic: identical inputs yield byte-identical output", () => {
    const a = buildSessionStats({ sessionId: "s1", messages: transcript() });
    const b = buildSessionStats({ sessionId: "s1", messages: transcript() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("counts each tool call exactly once (no double counting)", () => {
    const msgs: SessionMessage[] = [
      { role: "assistant", tool_calls: [call("edit"), call("edit")] },
      { role: "assistant", tool_calls: [call("edit")] },
    ];
    const stats = buildSessionStats({ sessionId: "s1", messages: msgs });
    expect(stats.tools.calls.byName).toEqual({ edit: 3 });
    expect(stats.tools.calls.total).toBe(3);
  });

  it("computes the context size as a chars/4 estimate", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: [{ role: "user", content: "x".repeat(400) }],
    });
    expect(stats.context.chars).toBe(400);
    expect(stats.context.tokens).toEqual({ kind: "estimate", value: 100 });
  });

  it("rolls overflow tool names into a single __other__ bucket", () => {
    const calls = Array.from({ length: 18 }, (_, i) => call(`tool_${String(i).padStart(2, "0")}`));
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: [{ role: "assistant", tool_calls: calls }],
    });
    const names = Object.keys(stats.tools.calls.byName);
    expect(names).toContain("__other__");
    // 16 named + 1 __other__ bucket.
    expect(names.length).toBe(17);
    expect(stats.tools.calls.total).toBe(18);
  });

  it("redacts a secret-shaped tool name so the view stays secret-safe", () => {
    const secret = "ghp_" + "a".repeat(24);
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: [{ role: "assistant", tool_calls: [call(secret)] }],
    });
    const names = Object.keys(stats.tools.calls.byName);
    expect(names).not.toContain(secret);
    expect(names.some((n) => n.includes("[REDACTED]"))).toBe(true);
  });

  it("carries redacted provenance through unchanged", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: [],
      model: "fake-model",
      workspace: "~/proj",
    });
    expect(stats.provenance).toEqual({ model: "fake-model", workspace: "~/proj" });
  });
});

describe("buildSessionStats — runtime enrichment and unavailable fields", () => {
  const runtime: SessionStatsRuntime = {
    rounds: 4,
    retries: 2,
    elapsedMs: 12_345,
    tokens: { prompt: 800, completion: 120, total: 920 },
    estimatedCostUsd: 0.0023,
    costKnown: true,
    toolFailures: { shell: 1 },
  };

  it("surfaces measured model activity when the runtime reported it", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript(), runtime });
    expect(stats.model.requests).toEqual({ kind: "measured", value: 4 });
    expect(stats.model.retries).toEqual({ kind: "measured", value: 2 });
    expect(stats.model.tokens.total).toEqual({ kind: "measured", value: 920 });
    expect(stats.model.tokens.prompt).toEqual({ kind: "measured", value: 800 });
    expect(stats.model.estimatedCostUsd).toEqual({ kind: "estimate", value: 0.0023 });
    expect(stats.model.costKnown).toBe(true);
    expect(stats.timing.elapsedMs).toEqual({ kind: "measured", value: 12_345 });
    expect(stats.tools.failures).toEqual({ kind: "measured", total: 1, byName: { shell: 1 } });
  });

  it("marks model activity and failures unavailable when there is no runtime", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript() });
    expect(stats.model.requests.kind).toBe("unavailable");
    expect(stats.model.retries.kind).toBe("unavailable");
    expect(stats.model.tokens.total.kind).toBe("unavailable");
    expect(stats.model.estimatedCostUsd.kind).toBe("unavailable");
    expect(stats.timing.elapsedMs.kind).toBe("unavailable");
    expect(stats.tools.failures.kind).toBe("unavailable");
    // Tool calls still come from the log even without a runtime.
    expect(stats.tools.calls.total).toBe(3);
  });

  it("reports measured-zero failures (not unavailable) when a runtime had none", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: transcript(),
      runtime: { rounds: 1, toolFailures: {} },
    });
    expect(stats.tools.failures).toEqual({ kind: "measured", total: 0, byName: {} });
  });

  it("never reports tokens as measured when the provider gave none", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: transcript(),
      runtime: { rounds: 2, tokens: null },
    });
    expect(stats.model.tokens.total.kind).toBe("unavailable");
    // The context size still has an estimate from the log.
    expect(stats.context.tokens.kind).toBe("estimate");
  });

  it("flags costKnown=false when a turn used the conservative fallback price", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: [],
      runtime: { estimatedCostUsd: 0.01, costKnown: false },
    });
    expect(stats.model.estimatedCostUsd.kind).toBe("estimate");
    expect(stats.model.costKnown).toBe(false);
  });
});

describe("formatSessionStats", () => {
  it("renders every section with provenance and no fabrication", () => {
    const stats = buildSessionStats({
      sessionId: "s1",
      messages: transcript(),
      model: "fake-model",
      workspace: "~/proj",
      runtime: {
        rounds: 3,
        retries: 1,
        elapsedMs: 5000,
        tokens: { prompt: 100, completion: 20, total: 120 },
        estimatedCostUsd: 0.001,
        costKnown: true,
        toolFailures: { shell: 1 },
      },
    });
    const text = formatSessionStats(stats).join("\n");
    expect(text).toContain("model fake-model");
    expect(text).toContain("repo ~/proj");
    expect(text).toContain("Session activity");
    expect(text).toContain("Context");
    expect(text).toContain("Model activity (this session)");
    expect(text).toContain("Tool outcomes");
    expect(text).toContain("Timing");
    expect(text).toContain("read_file×2, grep×1");
    expect(text).toContain("(est.)"); // context size / cost are estimates
    expect(text).toContain("est., not billing");
    expect(text).toContain("known model price");
    expect(text).toContain("5.0s"); // elapsed
  });

  it("renders unavailable runtime fields as n/a, never as a fabricated zero", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript() });
    const text = formatSessionStats(stats).join("\n");
    expect(text).toMatch(/requests\s+n\/a/);
    expect(text).toMatch(/retries\s+n\/a/);
    expect(text).toMatch(/est\. cost\s+n\/a/);
    expect(text).toMatch(/tool failures\s+n\/a/);
    expect(text).toMatch(/active time\s+n\/a/);
  });

  it("emits no ANSI when no style is supplied (headless / no-color)", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript() });
    expect(formatSessionStats(stats).join("")).not.toMatch(/\x1b\[/);
  });

  it("produces a stable, schema-tagged JSON document", () => {
    const stats = buildSessionStats({ sessionId: "s1", messages: transcript() });
    expect(stats.schema).toBe(SESSION_STATS_SCHEMA);
    expect(stats.v).toBe(SESSION_STATS_VERSION);
    const parsed = JSON.parse(JSON.stringify(stats));
    expect(parsed.schema).toBe(SESSION_STATS_SCHEMA);
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.activity.messages).toBe(5);
  });
});
