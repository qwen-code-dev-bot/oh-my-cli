import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.on("error", reject);
  });
}

// The fake provider reports a fixed usage of 5 prompt + 5 completion tokens per
// call. "fake-model" is not in the bundled price table, so it uses the
// conservative fallback rate (3 / 15 USD per 1M prompt/completion tokens):
//   per call = 5/1e6*3 + 5/1e6*15 = 0.00009 USD.
// The budget gate is checked BEFORE each provider call, so the first call always
// runs (cost starts at 0) and the run halts once the cumulative estimate meets
// the cap.
const PER_CALL_USD = 0.00009;

function toolCall(id: string) {
  return {
    type: "tool_calls" as const,
    toolCalls: [{ id, name: "shell", arguments: JSON.stringify({ command: "echo hi" }) }],
  };
}

describe("Integration: provider cost and spend budget", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-budget-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-budget-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("emits a usage record with per-round tokens and a cost estimate", async () => {
    server.setResponses([{ type: "text", content: "Hello" }]);

    const r = await runCli(
      ["-p", "hello", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const usage = recs.find((x) => x.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.round).toBe(0);
      expect(usage.promptTokens).toBe(5);
      expect(usage.completionTokens).toBe(5);
      expect(usage.totalTokens).toBe(10);
      expect(usage.estimatedCostUsd).toBeCloseTo(PER_CALL_USD, 9);
      // "fake-model" is not in the bundled table → conservative fallback rate.
      expect(usage.costKnown).toBe(false);
      expect(usage.budgetUsd).toBeNull();
      expect(usage.budgetReached).toBe(false);
    }
  });

  it("stops before further provider calls once the budget is reached", async () => {
    // Budget below a single call's cost: the first call runs, then the gate
    // trips before the second — exactly one provider request is made.
    server.setResponses([toolCall("c0"), toolCall("c1"), { type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "keep going", "--output", "json", "--budget", "0.00005", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(1);
    expect(server.requests.length).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    const complete = recs.find((x) => x.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.ok).toBe(false);
      expect(complete.reason).toBe("budget_reached");
      expect(complete.exitCode).toBe(1);
    }

    // The last usage record flags the budget as reached.
    const usages = recs.filter((x) => x.type === "usage");
    expect(usages.length).toBeGreaterThan(0);
    const last = usages[usages.length - 1];
    if (last?.type === "usage") {
      expect(last.budgetUsd).toBeCloseTo(0.00005, 9);
      expect(last.budgetReached).toBe(true);
    }
  });

  it("surfaces the actionable budget stop on stderr in text mode", async () => {
    // The console sink (default text mode) prints the stop to stderr; the
    // headless sink instead carries it as a JSON usage record (covered above).
    // Text mode keeps its existing exit semantics (no failure code on -p), so
    // the meaningful signals here are the halted call count and the message.
    server.setResponses([toolCall("c0"), toolCall("c1"), { type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "keep going", "--budget", "0.00005", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(server.requests.length).toBe(1);
    expect(r.stderr).toContain("Spend budget reached");
    expect(r.stderr).toContain("$0.000090");
  });

  it("enforces a cumulative budget across multiple calls before halting", async () => {
    // Budget between one and two calls' cost: two calls run, then the gate trips.
    server.setResponses([toolCall("c0"), toolCall("c1"), toolCall("c2"), { type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "keep going", "--output", "json", "--budget", "0.00015", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(1);
    expect(server.requests.length).toBe(2);

    const recs = parseHeadlessStream(r.stdout);
    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") expect(complete.reason).toBe("budget_reached");
  });

  it("honors the budget from OMC_SPEND_BUDGET_USD when no flag is given", async () => {
    server.setResponses([toolCall("c0"), toolCall("c1"), { type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "keep going", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      { ...baseEnv, OMC_SPEND_BUDGET_USD: "0.00005" },
    );

    expect(r.code).toBe(1);
    expect(server.requests.length).toBe(1);
    const recs = parseHeadlessStream(r.stdout);
    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") expect(complete.reason).toBe("budget_reached");
  });

  it("includes the estimated cost in the --summary output", async () => {
    server.setResponses([{ type: "text", content: "Done" }]);

    const r = await runCli(
      ["-p", "hello", "--summary", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("est. cost: $0.000090 (estimate, not billing)");
  });

  it("fails fast on an invalid budget value", async () => {
    const r = await runCli(["-p", "hello", "--budget", "abc", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid spend budget");
    // No provider call is made for an invalid budget.
    expect(server.requests.length).toBe(0);
  });
});
