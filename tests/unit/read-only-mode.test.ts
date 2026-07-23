import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";
import type { AgentSink } from "../../src/agent.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-readonly-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
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

const usage: StreamEvent = { type: "usage", promptTokens: 5, completionTokens: 5, totalTokens: 10 };

// A scripted provider: yields the given events on the first round, then a final
// text response on every subsequent round.
function scriptedProvider(firstRound: StreamEvent[]): StreamProvider {
  let call = 0;
  return async function* () {
    if (call === 0) {
      call++;
      for (const e of firstRound) yield e;
    } else {
      yield { type: "text", delta: "done" } as StreamEvent;
      yield usage;
    }
  };
}

function writeCallEvent(fileName: string): StreamEvent {
  return {
    type: "tool_call",
    id: "c1",
    name: "write",
    arguments: JSON.stringify({ path: fileName, content: "hi" }),
  };
}

function readCallEvent(fileName: string): StreamEvent {
  return {
    type: "tool_call",
    id: "c1",
    name: "read",
    arguments: JSON.stringify({ path: fileName }),
  };
}

async function run(
  repo: string,
  firstRound: StreamEvent[],
  opts: { readOnly: boolean; approvalMode: "yolo" | "default" },
) {
  return runAgent("investigate", [], {
    config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model: "test-model" },
    workspace: new Workspace(repo),
    approvalMode: opts.approvalMode,
    sessionId: "test-session",
    onMessage: () => {},
    sink: noopSink,
    streamProvider: scriptedProvider(firstRound),
    readOnly: opts.readOnly,
  });
}

describe("read-only mode gating", () => {
  it("refuses a mutating (write) tool fail-closed in read-only mode", async () => {
    const repo = makeRepo();
    const result = await run(repo, [writeCallEvent("x.txt"), usage], { readOnly: true, approvalMode: "yolo" });
    expect(result.stats.toolFailures.write).toBe(1);
    // The write did not happen.
    expect(fs.existsSync(path.join(repo, "x.txt"))).toBe(false);
  });

  it("refuses a mutating tool even under yolo (read-only is a hard floor)", async () => {
    const repo = makeRepo();
    const result = await run(repo, [writeCallEvent("y.txt"), usage], { readOnly: true, approvalMode: "yolo" });
    expect(result.stats.toolFailures.write).toBe(1);
    expect(fs.existsSync(path.join(repo, "y.txt"))).toBe(false);
  });

  it("allows a read-only tool in read-only mode", async () => {
    const repo = makeRepo();
    const result = await run(repo, [readCallEvent("a.txt"), usage], { readOnly: true, approvalMode: "yolo" });
    // The read succeeded (not counted as a failure).
    expect(result.stats.toolFailures.read).toBeUndefined();
    expect(result.stats.toolCalls.read).toBe(1);
  });

  it("allows a mutating tool when read-only mode is off (control)", async () => {
    const repo = makeRepo();
    const result = await run(repo, [writeCallEvent("z.txt"), usage], { readOnly: false, approvalMode: "yolo" });
    expect(result.stats.toolFailures.write).toBeUndefined();
    expect(fs.existsSync(path.join(repo, "z.txt"))).toBe(true);
  });
});
