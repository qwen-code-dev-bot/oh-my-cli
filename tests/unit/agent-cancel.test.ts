import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import type { AgentSink } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";
import type { SessionMessage } from "../../src/session.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-cancel-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"], { stdio: ["ignore", "pipe", "ignore"] });
  return repo;
}

function silentSink(): AgentSink {
  return {
    assistantDelta: () => {},
    assistantTurn: () => {},
    toolStart: () => {},
    toolResult: () => {},
    providerError: () => {},
    usage: () => {},
    retry: () => {},
  };
}

const baseConfig = {
  apiKey: "test-key",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

describe("runAgent cooperative cancellation (#489)", () => {
  it("stops before any provider call when cancelled while queued", async () => {
    let called = 0;
    const provider: StreamProvider = async function* () {
      called++;
      yield { type: "text", delta: "should never stream" } as StreamEvent;
    };
    const persisted: SessionMessage[] = [];
    const result = await runAgent("queued cancel", [], {
      config: baseConfig,
      workspace: new Workspace(makeRepo()),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: (m) => persisted.push(m),
      sink: silentSink(),
      streamProvider: provider,
      cancelRequested: () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancelled");
    expect(called).toBe(0);
    // The submitted user turn is persisted; no assistant turn exists.
    expect(persisted.filter((m) => m.role === "user").length).toBe(1);
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(0);
  });

  it("persists streamed text as exactly one interrupted turn when cancelled mid-stream", async () => {
    const persisted: SessionMessage[] = [];
    let cancel = false;
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "Partial " } as StreamEvent;
      cancel = true; // the user cancels after the first token
      yield { type: "text", delta: "answer" } as StreamEvent;
    };
    const result = await runAgent("cancel mid-stream", [], {
      config: baseConfig,
      workspace: new Workspace(makeRepo()),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: (m) => persisted.push(m),
      sink: silentSink(),
      streamProvider: provider,
      cancelRequested: () => cancel,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancelled");

    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("Partial answer");
    expect(assistants[0].interrupted).toBe(true);
    expect(assistants[0].tool_calls).toBeUndefined();
  });

  it("creates no assistant entry when cancelled mid-stream before any text", async () => {
    const persisted: SessionMessage[] = [];
    let cancel = false;
    const provider: StreamProvider = async function* () {
      // The user cancels while only a tool-call event is in flight; no
      // assistant text was ever streamed.
      cancel = true;
      yield {
        type: "tool_call",
        id: "c1",
        name: "read",
        arguments: JSON.stringify({ path: "a.txt" }),
      } as StreamEvent;
    };
    const result = await runAgent("cancel before text", [], {
      config: baseConfig,
      workspace: new Workspace(makeRepo()),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: (m) => persisted.push(m),
      sink: silentSink(),
      streamProvider: provider,
      cancelRequested: () => cancel,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancelled");
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(0);
    // The partial tool call was neither persisted nor executed.
    expect(persisted.filter((m) => m.role === "tool").length).toBe(0);
  });
});

describe("runAgent retry reuses one request identity (#489)", () => {
  it("does not create or persist another user message when appendUserMessage is false", async () => {
    const persisted: SessionMessage[] = [];
    const existing: SessionMessage[] = [
      { role: "system", content: "seed" },
      { role: "user", content: "original turn" },
      { role: "assistant", content: "failed attempt", interrupted: true },
    ];
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "recovered" } as StreamEvent;
    };
    const result = await runAgent("original turn", existing, {
      config: baseConfig,
      workspace: new Workspace(makeRepo()),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: (m) => persisted.push(m),
      sink: silentSink(),
      streamProvider: provider,
      appendUserMessage: false,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    // Only the recovered assistant turn is persisted; the user message is not duplicated.
    expect(persisted.filter((m) => m.role === "user").length).toBe(0);
    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("recovered");
  });

  it("still persists the user message by default", async () => {
    const persisted: SessionMessage[] = [];
    const provider: StreamProvider = async function* () {
      yield { type: "text", delta: "answer" } as StreamEvent;
    };
    const result = await runAgent("ordinary turn", [], {
      config: baseConfig,
      workspace: new Workspace(makeRepo()),
      approvalMode: "yolo",
      sessionId: "test-session",
      onMessage: (m) => persisted.push(m),
      sink: silentSink(),
      streamProvider: provider,
    });

    expect(result.ok).toBe(true);
    expect(persisted.filter((m) => m.role === "user").length).toBe(1);
  });
});
