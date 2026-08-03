import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import type { AgentSink } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-runcaps-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
  return repo;
}

const noopSink: AgentSink = {
  assistantDelta: () => {},
  assistantTurn: () => {},
  toolStart: () => {},
  toolResult: () => {},
  providerError: () => {},
  usage: () => {},
  retry: () => {},
};

const USAGE: StreamEvent = { type: "usage", promptTokens: 5, completionTokens: 5, totalTokens: 10 };

function readCallEvent(id: string): StreamEvent {
  return { type: "tool_call", id, name: "read", arguments: JSON.stringify({ path: "a.txt" }) };
}

// A scripted provider that keeps issuing a read tool call for the first
// `toolRounds` calls (forcing agent rounds), then answers with text. Counts
// calls so tests can assert exactly how many provider rounds happened.
function loopingProvider(toolRounds: number): { provider: StreamProvider; calls: () => number } {
  let call = 0;
  const provider: StreamProvider = async function* () {
    const index = call;
    call++;
    if (index < toolRounds) {
      yield readCallEvent(`c${index}`);
      yield USAGE;
    } else {
      yield { type: "text", delta: "done" } as StreamEvent;
      yield USAGE;
    }
  };
  return { provider, calls: () => call };
}

interface RunOpts {
  maxTurns?: number | null;
  maxWallTimeMs?: number | null;
  runClock?: () => number;
}

async function run(provider: StreamProvider, opts: RunOpts = {}) {
  const repo = makeRepo();
  const result = await runAgent("do the thing", [], {
    config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" },
    workspace: new Workspace(repo),
    approvalMode: "yolo",
    sessionId: "test-session",
    onMessage: () => {},
    sink: noopSink,
    streamProvider: provider,
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.maxWallTimeMs !== undefined ? { maxWallTimeMs: opts.maxWallTimeMs } : {}),
    ...(opts.runClock ? { runClock: opts.runClock } : {}),
  });
  return result;
}

describe("runAgent operator run caps (Issue #515)", () => {
  it("runs to completion when no cap is set", async () => {
    const { provider } = loopingProvider(1);
    const result = await run(provider);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.rounds).toBe(2);
  });

  it("stops before the (n+1)th round with max_turns_reached", async () => {
    const { provider, calls } = loopingProvider(10);
    const result = await run(provider, { maxTurns: 2 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_turns_reached");
    expect(result.rounds).toBe(2);
    expect(calls()).toBe(2); // exactly two provider rounds happened
  });

  it("max-turns 1 stops after a single round", async () => {
    const { provider, calls } = loopingProvider(10);
    const result = await run(provider, { maxTurns: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_turns_reached");
    expect(result.rounds).toBe(1);
    expect(calls()).toBe(1);
  });

  it("a capped stop at a round boundary keeps the run consistent (no partial turn)", async () => {
    const { provider } = loopingProvider(10);
    const result = await run(provider, { maxTurns: 1 });
    // The capped round's tool call ran to its result before the boundary stop.
    expect(result.stats.toolCalls.read).toBe(1);
    expect(result.stats.toolFailures.read ?? 0).toBe(0);
  });

  it("stops at the first round boundary after the wall-time budget with wall_time_reached", async () => {
    const { provider, calls } = loopingProvider(10);
    // Deterministic clock: run starts at t=1000; every later reading advances
    // one second. Round 0 gate sees 1s elapsed (< 1.5s budget) and proceeds;
    // round 1 gate sees >= 2s elapsed and stops.
    let t = 0;
    const runClock = () => 1000 * ++t;
    const result = await run(provider, { maxWallTimeMs: 1500, runClock });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wall_time_reached");
    expect(result.rounds).toBe(1);
    expect(calls()).toBe(1);
  });

  it("an elapsed wall-time budget stops before any provider call", async () => {
    const { provider, calls } = loopingProvider(10);
    let t = 0;
    const runClock = () => 1000 * ++t;
    const result = await run(provider, { maxWallTimeMs: 0, runClock });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wall_time_reached");
    expect(result.rounds).toBe(0);
    expect(calls()).toBe(0);
  });

  it("caps do not disturb an uncapped run that finishes first", async () => {
    const { provider } = loopingProvider(1);
    const result = await run(provider, { maxTurns: 50, maxWallTimeMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
  });
});
