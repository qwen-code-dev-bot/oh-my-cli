import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeMessageTiming, formatMessageUsageLine } from "../../src/message-usage.js";
import type { MessageUsage } from "../../src/message-usage.js";
import { runAgent } from "../../src/agent.js";
import type { AgentSink, AgentUsage } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";

describe("computeMessageTiming", () => {
  it("derives TTFT and throughput from raw timestamps", () => {
    const t = computeMessageTiming({
      requestStartMs: 1000,
      firstTokenMs: 1200,
      generationEndMs: 2000,
      completionTokens: 100,
    });
    expect(t.ttftMs).toBe(200);
    // 100 tokens over a 1000ms call wall-time = 100 tok/s.
    expect(t.tokensPerSecond).toBe(100);
  });

  it("rounds throughput to two decimals", () => {
    const t = computeMessageTiming({
      requestStartMs: 0,
      firstTokenMs: 10,
      generationEndMs: 3000,
      completionTokens: 100,
    });
    expect(t.tokensPerSecond).toBe(33.33);
  });

  it("omits TTFT when no text token arrived but still reports throughput", () => {
    const t = computeMessageTiming({
      requestStartMs: 1000,
      firstTokenMs: null,
      generationEndMs: 2000,
      completionTokens: 50,
    });
    expect(t.ttftMs).toBeNull();
    expect(t.tokensPerSecond).toBe(50);
  });

  it("omits throughput when usage is absent", () => {
    const t = computeMessageTiming({
      requestStartMs: 1000,
      firstTokenMs: 1100,
      generationEndMs: 2000,
      completionTokens: null,
    });
    expect(t.ttftMs).toBe(100);
    expect(t.tokensPerSecond).toBeNull();
  });

  it("omits throughput on a zero-length call rather than dividing by zero", () => {
    const t = computeMessageTiming({
      requestStartMs: 1000,
      firstTokenMs: 1000,
      generationEndMs: 1000,
      completionTokens: 10,
    });
    expect(t.ttftMs).toBe(0);
    expect(t.tokensPerSecond).toBeNull();
  });

  it("omits throughput when there were no completion tokens", () => {
    const t = computeMessageTiming({
      requestStartMs: 1000,
      firstTokenMs: 1050,
      generationEndMs: 2000,
      completionTokens: 0,
    });
    expect(t.tokensPerSecond).toBeNull();
  });

  it("omits everything when the request start is unknown", () => {
    const t = computeMessageTiming({
      requestStartMs: null,
      firstTokenMs: 1050,
      generationEndMs: 2000,
      completionTokens: 10,
    });
    expect(t.ttftMs).toBeNull();
    expect(t.tokensPerSecond).toBeNull();
  });
});

function usage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    round: 0,
    promptTokens: 10,
    completionTokens: 6,
    totalTokens: 16,
    estimatedCostUsd: 0.00012,
    costKnown: true,
    ttftMs: 200,
    tokensPerSecond: 100,
    ...overrides,
  };
}

describe("formatMessageUsageLine", () => {
  it("renders tokens, estimated cost, TTFT, and throughput", () => {
    const line = formatMessageUsageLine(usage());
    expect(line).toContain("tokens 16 (prompt 10, completion 6)");
    expect(line).toContain("cost $0.000120 (est)");
    expect(line).toContain("TTFT 200ms");
    expect(line).toContain("100 tok/s");
  });

  it("omits TTFT and throughput when unavailable", () => {
    const line = formatMessageUsageLine(usage({ ttftMs: null, tokensPerSecond: null }));
    expect(line).not.toContain("TTFT");
    expect(line).not.toContain("tok/s");
    expect(line).toContain("tokens 16");
  });

  it("labels the fallback rate when the model price is unknown", () => {
    const line = formatMessageUsageLine(usage({ costKnown: false }));
    expect(line).toContain("(est, fallback rate)");
  });
});

// Behavioral: the agent loop captures per-message timing around the stream and
// reports it through the sink. A scripted provider plus an injected clock make
// the timing deterministic.
describe("runAgent per-message timing", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-msgusage-"));
    tmpDirs.push(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
    return repo;
  }

  it("reports TTFT and throughput for a streamed text turn", async () => {
    const repo = makeRepo();
    const seen: AgentUsage[] = [];
    const sink: AgentSink = {
      assistantDelta: () => {},
      assistantTurn: () => {},
      toolStart: () => {},
      toolResult: () => {},
      providerError: () => {},
      usage: (info) => seen.push(info),
      retry: () => {},
    };
    // One streamed text turn: two text deltas, then a usage chunk reporting 100
    // completion tokens.
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "Hel" } as StreamEvent;
      yield { type: "text", delta: "lo" } as StreamEvent;
      yield { type: "usage", promptTokens: 5, completionTokens: 100, totalTokens: 105 } as StreamEvent;
    };
    // Deterministic clock: roundStart=1000, first text token=1200, end=2000.
    const times = [1000, 1200, 2000];
    let i = 0;
    const now = () => times[i++] ?? 2000;

    const result = await runAgent("hi", [], {
      config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" },
      workspace: new Workspace(repo),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: () => {},
      sink,
      streamProvider: provider,
      now,
    });

    expect(result.ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0].ttftMs).toBe(200);
    // 100 completion tokens over a 1000ms call = 100 tok/s.
    expect(seen[0].tokensPerSecond).toBe(100);
  });

  it("omits TTFT for a turn that streams no text token", async () => {
    const repo = makeRepo();
    const seen: AgentUsage[] = [];
    const sink: AgentSink = {
      assistantDelta: () => {},
      assistantTurn: () => {},
      toolStart: () => {},
      toolResult: () => {},
      providerError: () => {},
      usage: (info) => seen.push(info),
      retry: () => {},
    };
    // First round emits only a tool call (no text) plus usage; the second round
    // ends the loop with a text turn.
    let call = 0;
    const provider: StreamProvider = async function* () {
      if (call === 0) {
        call++;
        yield {
          type: "tool_call",
          id: "c1",
          name: "read",
          arguments: JSON.stringify({ path: "a.txt" }),
        } as StreamEvent;
        yield { type: "usage", promptTokens: 5, completionTokens: 8, totalTokens: 13 } as StreamEvent;
      } else {
        yield { type: "text", delta: "done" } as StreamEvent;
        yield { type: "usage", promptTokens: 5, completionTokens: 4, totalTokens: 9 } as StreamEvent;
      }
    };
    const times = [1000, 2000, 3000, 3200, 4000];
    let i = 0;
    const now = () => times[i++] ?? 4000;

    await runAgent("read it", [], {
      config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" },
      workspace: new Workspace(repo),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: () => {},
      sink,
      streamProvider: provider,
      now,
    });

    // The first (tool-only) turn streamed no text token, so TTFT is omitted even
    // though throughput is still derivable from the call wall-time.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].ttftMs).toBeNull();
    expect(seen[0].tokensPerSecond).not.toBeNull();
  });
});
