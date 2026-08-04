import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/agent.js";
import type { AgentSink, AgentFallback } from "../../src/agent.js";
import { Workspace } from "../../src/workspace.js";
import type { StreamProvider, StreamEvent } from "../../src/provider.js";
import type { SessionMessage } from "../../src/session.js";
import { estimateCostUsd } from "../../src/cost.js";
import { validateFallbackModel } from "../../src/preflight.js";
import { buildRunSummary, formatRunSummary } from "../../src/run-summary.js";
import {
  HeadlessWriter,
  createHeadlessSink,
  parseHeadlessStream,
} from "../../src/headless-protocol.js";
import type { HeadlessRecord } from "../../src/headless-protocol.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-590u-"));
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
  fallbacks: AgentFallback[];
  usageCosts: Array<{ estimatedCostUsd: number; costKnown: boolean }>;
}

function capturingSink(): Capture {
  const turns: Capture["turns"] = [];
  const errors: string[] = [];
  const fallbacks: AgentFallback[] = [];
  const usageCosts: Capture["usageCosts"] = [];
  const sink: AgentSink = {
    assistantDelta: () => {},
    assistantTurn: (text, _round, opts) => {
      turns.push({ text, final: opts.final, interrupted: opts.interrupted === true });
    },
    toolStart: () => {},
    toolResult: () => {},
    providerError: (message) => errors.push(message),
    usage: (info) => {
      usageCosts.push({ estimatedCostUsd: info.estimatedCostUsd, costKnown: info.costKnown });
    },
    retry: () => {},
    fallback: (info) => fallbacks.push(info),
  };
  return { sink, turns, errors, fallbacks, usageCosts };
}

async function run(provider: StreamProvider, fallbackModel?: string | null, model = "primary-model") {
  const repo = makeRepo();
  const persisted: SessionMessage[] = [];
  const cap = capturingSink();
  const result = await runAgent("do the thing", [], {
    config: { apiKey: "test-key", baseUrl: "https://example.com/v1", model },
    workspace: new Workspace(repo),
    approvalMode: "yolo",
    sessionId: "test-session",
    onMessage: (m) => persisted.push(m),
    sink: cap.sink,
    streamProvider: provider,
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
  });
  return { result, persisted, cap };
}

function transientError(status: number): Error {
  return Object.assign(new Error(`fake ${status}`), { status });
}

describe("one-shot fallback model degrade (Issue #590)", () => {
  it("degrades once and completes on the fallback after a retryable failure before output", async () => {
    const provider: StreamProvider = async function* (config) {
      if (config.model === "primary-model") {
        throw transientError(503);
      }
      yield { type: "text", delta: "fallback answer" } as StreamEvent;
    };
    const { result, persisted, cap } = await run(provider, "fallback-model");

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("fallback answer");
    expect(result.fellBack).toBe(true);
    expect(result.fallbackModel).toBe("fallback-model");

    expect(cap.fallbacks).toHaveLength(1);
    expect(cap.fallbacks[0].fromModel).toBe("primary-model");
    expect(cap.fallbacks[0].toModel).toBe("fallback-model");
    expect(cap.fallbacks[0].reasonClass).toBe("server_error");
    expect(cap.errors).toHaveLength(0);

    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("fallback answer");
    expect(assistants[0].interrupted).toBeUndefined();
  });

  it("fails as today when no fallback is configured", async () => {
    const provider: StreamProvider = async function* () {
      throw transientError(503);
      yield {} as StreamEvent; // unreachable; keeps this an async generator
    };
    const { result, cap } = await run(provider);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.fellBack).toBe(false);
    expect(result.fallbackModel).toBeNull();
    expect(cap.fallbacks).toHaveLength(0);
    expect(cap.errors).toHaveLength(1);
  });

  it("never degrades after output was produced (partial turn preserved)", async () => {
    const provider: StreamProvider = async function* (config) {
      if (config.model === "primary-model") {
        yield { type: "text", delta: "partial" } as StreamEvent;
        throw transientError(503);
      }
      yield { type: "text", delta: "fallback answer" } as StreamEvent;
    };
    const { result, persisted, cap } = await run(provider, "fallback-model");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.fellBack).toBe(false);
    expect(result.fallbackModel).toBeNull();
    expect(cap.fallbacks).toHaveLength(0);
    const assistants = persisted.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("partial");
    expect(assistants[0].interrupted).toBe(true);
  });

  it("never degrades on a non-retryable failure", async () => {
    const provider: StreamProvider = async function* () {
      throw Object.assign(new Error("auth rejected"), { status: 401 });
      yield {} as StreamEvent; // unreachable; keeps this an async generator
    };
    const { result, cap } = await run(provider, "fallback-model");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.fellBack).toBe(false);
    expect(cap.fallbacks).toHaveLength(0);
  });

  it("never degrades twice: a fallback failure terminates the run", async () => {
    const provider: StreamProvider = async function* () {
      throw transientError(503);
      yield {} as StreamEvent; // unreachable; keeps this an async generator
    };
    const { result, cap } = await run(provider, "fallback-model");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.fellBack).toBe(true);
    expect(result.fallbackModel).toBe("fallback-model");
    // Exactly one degrade notice even though both models failed.
    expect(cap.fallbacks).toHaveLength(1);
    expect(cap.errors).toHaveLength(1);
  });

  it("splits cost at the degrade: primary tokens keep the primary price", async () => {
    let call = 0;
    const provider: StreamProvider = async function* (config) {
      call++;
      if (call === 1) {
        // Round 1 under the primary: one read-only tool call plus usage.
        yield {
          type: "tool_call",
          id: "c1",
          name: "list",
          arguments: JSON.stringify({ path: "." }),
        } as StreamEvent;
        yield { type: "usage", promptTokens: 5, completionTokens: 5, totalTokens: 10 } as StreamEvent;
        return;
      }
      if (config.model === "gpt-4o") {
        throw transientError(503);
      }
      yield { type: "text", delta: "done via fallback" } as StreamEvent;
      yield { type: "usage", promptTokens: 5, completionTokens: 5, totalTokens: 10 } as StreamEvent;
    };
    const { result, cap } = await run(provider, "gpt-4o-mini", "gpt-4o");

    expect(result.ok).toBe(true);
    expect(result.fellBack).toBe(true);
    expect(result.fallbackModel).toBe("gpt-4o-mini");

    // Round-1 usage is priced entirely under the primary model.
    const roundOne = estimateCostUsd("gpt-4o", { prompt: 5, completion: 5 }).usd;
    expect(cap.usageCosts[0].estimatedCostUsd).toBeCloseTo(roundOne, 12);
    // Final cost: primary price for the first 5/5 tokens, fallback price for
    // the 5/5 streamed after the degrade — never one blended rate.
    const expected =
      roundOne + estimateCostUsd("gpt-4o-mini", { prompt: 5, completion: 5 }).usd;
    expect(result.estimatedCostUsd).not.toBeNull();
    expect(result.estimatedCostUsd!).toBeCloseTo(expected, 12);
    // Both prices are in the bundled table, so the estimate stays known.
    expect(result.costKnown).toBe(true);
  });

  it("reports the degrade honestly in the run summary and renders it", () => {
    const degraded = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: 100,
      rounds: 1,
      toolCalls: {},
      toolFailures: {},
      tokens: null,
      sessionId: "s1",
      sessionPath: null,
      fellBack: true,
      fallbackModel: "fallback-model",
    });
    expect(degraded.fellBack).toBe(true);
    expect(degraded.fallbackModel).toBe("fallback-model");
    expect(formatRunSummary(degraded)).toContain('fallback:  degraded to "fallback-model"');

    // Omitted fields default to the honest no-degrade state.
    const plain = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: 100,
      rounds: 1,
      toolCalls: {},
      toolFailures: {},
      tokens: null,
      sessionId: "s1",
      sessionPath: null,
    });
    expect(plain.fellBack).toBe(false);
    expect(plain.fallbackModel).toBeNull();
    expect(formatRunSummary(plain)).not.toContain("fallback:");

    // A degrade claim without a model name collapses to no-degrade rather
    // than rendering an empty claim.
    const dangling = buildRunSummary({
      ok: true,
      exitCode: 0,
      reason: "completed",
      elapsedMs: 100,
      rounds: 1,
      toolCalls: {},
      toolFailures: {},
      tokens: null,
      sessionId: "s1",
      sessionPath: null,
      fellBack: true,
      fallbackModel: "   ",
    });
    expect(dangling.fallbackModel).toBeNull();
  });

  it("emits a bounded fallback record in the headless stream", () => {
    const chunks: string[] = [];
    const out = { write: (s: string) => Boolean(chunks.push(s)) };
    const sink = createHeadlessSink(new HeadlessWriter(out));
    sink.fallback?.({
      round: 2,
      fromModel: "primary-model",
      toModel: "fallback-model",
      reasonClass: "server_error",
    });
    const recs: HeadlessRecord[] = parseHeadlessStream(chunks.join(""));
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    if (rec.type !== "fallback") throw new Error("expected a fallback record");
    expect(rec.round).toBe(2);
    expect(rec.fromModel).toBe("primary-model");
    expect(rec.toModel).toBe("fallback-model");
    expect(rec.reasonClass).toBe("server_error");
  });

  it("validateFallbackModel is a no-op without a configured fallback", async () => {
    const result = await validateFallbackModel({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "primary-model",
    });
    expect(result.ok).toBe(true);
  });
});
