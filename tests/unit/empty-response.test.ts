import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import type { AgentSink, AgentUsage } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";
import { RETRY_MAX_ATTEMPTS } from "../../src/provider.js";
import type { SessionMessage } from "../../src/session.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-empty-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
  return repo;
}

const USAGE: StreamEvent = { type: "usage", promptTokens: 5, completionTokens: 5, totalTokens: 10 };

// A scripted provider that yields one event list per call (per agent attempt).
function scriptedProvider(rounds: StreamEvent[][]): StreamProvider {
  let call = 0;
  return async function* () {
    const events = call < rounds.length ? rounds[call] : [];
    call++;
    for (const e of events) yield e;
  };
}

// A provider that always returns an empty completion (usage only, no text/tools).
function alwaysEmptyProvider(): StreamProvider {
  return async function* () {
    yield USAGE;
  };
}

interface Capture {
  sink: AgentSink;
  retries: Array<{ attempt: number; maxAttempts: number; reasonClass: string }>;
  turns: Array<{ text: string; final: boolean; interrupted: boolean }>;
  errors: string[];
  usages: AgentUsage[];
}

function capturingSink(): Capture {
  const retries: Capture["retries"] = [];
  const turns: Capture["turns"] = [];
  const errors: string[] = [];
  const usages: AgentUsage[] = [];
  const sink: AgentSink = {
    assistantDelta: () => {},
    assistantTurn: (text, _r, opts) => turns.push({ text, final: opts.final, interrupted: opts.interrupted === true }),
    toolStart: () => {},
    toolResult: () => {},
    providerError: (m) => errors.push(m),
    usage: (info) => usages.push(info),
    retry: (info) => retries.push({ attempt: info.attempt, maxAttempts: info.maxAttempts, reasonClass: info.reasonClass }),
  };
  return { sink, retries, turns, errors, usages };
}

async function run(provider: StreamProvider, budgetUsd?: number) {
  const repo = makeRepo();
  const persisted: SessionMessage[] = [];
  const cap = capturingSink();
  const result = await runAgent("do the thing", [], {
    config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" },
    workspace: new Workspace(repo),
    approvalMode: "yolo",
    sessionId: "test-session",
    onMessage: (m) => persisted.push(m),
    sink: cap.sink,
    streamProvider: provider,
    budgetUsd,
  });
  return { result, persisted, cap };
}

describe("runAgent bounded recovery from empty completions (#244)", () => {
  it("keeps current behavior for a valid text completion (no retry)", async () => {
    const provider = scriptedProvider([[{ type: "text", delta: "hello" }, USAGE]]);
    const { result, cap } = await run(provider);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("hello");
    expect(cap.retries.length).toBe(0);
  });

  it("keeps current behavior for a valid tool-call completion (no empty retry)", async () => {
    const provider = scriptedProvider([
      [{ type: "tool_call", id: "c1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) }, USAGE],
      [{ type: "text", delta: "done" }, USAGE],
    ]);
    const { result, cap } = await run(provider);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    expect(cap.retries.filter((r) => r.reasonClass === "empty_response").length).toBe(0);
  });

  it("recovers from an empty completion followed by a valid one with exactly one empty_response retry", async () => {
    const provider = scriptedProvider([
      [USAGE], // empty completion
      [{ type: "text", delta: "real answer" }, USAGE],
    ]);
    const { result, persisted, cap } = await run(provider);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("real answer");

    const emptyRetries = cap.retries.filter((r) => r.reasonClass === "empty_response");
    expect(emptyRetries.length).toBe(1);
    expect(emptyRetries[0].maxAttempts).toBe(RETRY_MAX_ATTEMPTS);

    // Only the valid assistant turn is persisted; the empty attempt leaves nothing.
    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("real answer");
    expect(assistants[0].interrupted).toBeUndefined();

    // Usage from BOTH attempts is accounted (5+5 prompt, 5+5 completion).
    expect(result.tokens).toEqual({ prompt: 10, completion: 10, total: 20 });
  });

  it("exhausts the fixed retry cap on persistent empty completions and fails truthfully", async () => {
    const { result, persisted, cap } = await run(alwaysEmptyProvider());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty_response");
    expect(result.text).toBe("");

    // RETRY_MAX_ATTEMPTS total attempts => RETRY_MAX_ATTEMPTS-1 retry events.
    const emptyRetries = cap.retries.filter((r) => r.reasonClass === "empty_response");
    expect(emptyRetries.length).toBe(RETRY_MAX_ATTEMPTS - 1);
    expect(cap.errors.length).toBe(1);

    // No assistant transcript entry (empty or otherwise) is persisted.
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(0);
    // Every empty attempt's usage is still accounted.
    expect(result.tokens).toEqual({
      prompt: 5 * RETRY_MAX_ATTEMPTS,
      completion: 5 * RETRY_MAX_ATTEMPTS,
      total: 10 * RETRY_MAX_ATTEMPTS,
    });
  });

  it("lets the spend budget prevent the next retry after an empty attempt", async () => {
    // The first empty attempt's estimated cost (~$0.00009 at the fallback rate)
    // exceeds this tiny budget, so the loop stops before retrying.
    const { result, persisted, cap } = await run(alwaysEmptyProvider(), 0.00001);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("budget_reached");
    expect(cap.retries.filter((r) => r.reasonClass === "empty_response").length).toBe(0);
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(0);
  });
});
