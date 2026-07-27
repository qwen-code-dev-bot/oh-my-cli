import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import type { AgentSink } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";
import { SessionStore } from "../../src/session.js";
import type { SessionMessage } from "../../src/session.js";
import {
  HeadlessWriter,
  createHeadlessSink,
  parseHeadlessStream,
} from "../../src/headless-protocol.js";
import type { HeadlessRecord } from "../../src/headless-protocol.js";
import { buildSessionManifest, renderSessionMarkdown } from "../../src/session-export.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-partial-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
  return repo;
}

interface Capture {
  sink: AgentSink;
  turns: Array<{ text: string; final: boolean; interrupted: boolean }>;
  errors: string[];
}

function capturingSink(): Capture {
  const turns: Capture["turns"] = [];
  const errors: string[] = [];
  const sink: AgentSink = {
    assistantDelta: () => {},
    assistantTurn: (text, _round, opts) => {
      turns.push({ text, final: opts.final, interrupted: opts.interrupted === true });
    },
    toolStart: () => {},
    toolResult: () => {},
    providerError: (message) => errors.push(message),
    usage: () => {},
    retry: () => {},
  };
  return { sink, turns, errors };
}

async function run(provider: StreamProvider) {
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
  });
  return { result, persisted, cap };
}

describe("runAgent preserves a partial assistant turn on mid-stream failure (#243)", () => {
  it("persists exactly one interrupted assistant entry when text was emitted before the failure", async () => {
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "Hello " } as StreamEvent;
      yield { type: "text", delta: "world" } as StreamEvent;
      throw new Error("stream failed mid-turn");
    };
    const { result, persisted, cap } = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.text).toBe("Hello world");

    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("Hello world");
    expect(assistants[0].interrupted).toBe(true);
    // No tool calls are persisted on the interrupted turn.
    expect(assistants[0].tool_calls).toBeUndefined();

    // The sink saw the interrupted turn before the provider error.
    expect(cap.turns.length).toBe(1);
    expect(cap.turns[0].interrupted).toBe(true);
    expect(cap.turns[0].final).toBe(false);
    expect(cap.errors.length).toBe(1);
  });

  it("creates no assistant entry when the failure precedes any text", async () => {
    const provider: StreamProvider = async function* () {
      throw new Error("failed before any output");
      yield {} as StreamEvent; // unreachable; keeps this an async generator
    };
    const { result, persisted, cap } = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(0);
    expect(cap.turns.length).toBe(0);
    expect(cap.errors.length).toBe(1);
  });

  it("preserves emitted text but never persists or executes a partial tool call", async () => {
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "Let me check" } as StreamEvent;
      yield {
        type: "tool_call",
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({ command: "echo hi" }),
      } as StreamEvent;
      throw new Error("stream failed after a partial tool call");
    };
    const { result, persisted } = await run(provider);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");

    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("Let me check");
    expect(assistants[0].interrupted).toBe(true);
    expect(assistants[0].tool_calls).toBeUndefined();
    // The partial tool call was never executed: no tool result was persisted.
    expect(persisted.filter((m) => m.role === "tool").length).toBe(0);
  });
});

class FakeOut {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  records(): HeadlessRecord[] {
    return parseHeadlessStream(this.chunks.join(""));
  }
}

describe("headless assistant record carries the interrupted flag (#243)", () => {
  it("marks a partial turn interrupted:true and a normal turn interrupted:false", () => {
    const out = new FakeOut();
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.assistantTurn("partial text", 0, { final: false, interrupted: true });
    sink.assistantTurn("normal text", 1, { final: true });

    const recs = out.records();
    expect(recs.length).toBe(2);
    const [partial, normal] = recs;
    if (partial.type !== "assistant" || normal.type !== "assistant") throw new Error("unreachable");
    expect(partial.interrupted).toBe(true);
    expect(partial.final).toBe(false);
    expect(partial.text).toBe("partial text");
    expect(normal.interrupted).toBe(false);
    expect(normal.final).toBe(true);
  });
});

describe("session persistence and export preserve the interrupted marker (#243)", () => {
  it("round-trips the interrupted flag and labels it exactly once in export", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-partial-store-"));
    tmpDirs.push(dir);
    const store = new SessionStore(dir);
    const id = store.newId();
    store.append(id, { role: "user", content: "do the thing" });
    store.append(id, { role: "assistant", content: "Hello world", interrupted: true });

    // Resume: load preserves the marker without duplication.
    const loaded = store.load(id);
    const assistants = loaded.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].interrupted).toBe(true);
    expect(assistants[0].content).toBe("Hello world");

    // Export: the transcript labels the interrupted turn exactly once.
    const built = buildSessionManifest(store, id);
    if ("error" in built) throw new Error(built.error);
    const md = renderSessionMarkdown(built.manifest, built.messages);
    expect(md).toContain("### assistant (interrupted)");
    expect(md.split("### assistant (interrupted)").length - 1).toBe(1);
    expect(md).toContain("Hello world");
  });
});
