import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRunSummary } from "../../src/run-summary.js";
import type { RunSummary } from "../../src/run-summary.js";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
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

function summary(over: Partial<Parameters<typeof buildRunSummary>[0]> = {}): RunSummary {
  return buildRunSummary({
    ok: true,
    exitCode: 0,
    reason: "completed",
    elapsedMs: 1000,
    rounds: 2,
    toolCalls: { read: 2, shell: 1 },
    toolFailures: {},
    tokens: { prompt: 5, completion: 5, total: 10 },
    sessionId: "sess",
    sessionPath: "~/.oh-my-cli/sessions/sess.jsonl",
    ...over,
  });
}

describe("Integration: scorecard (--baseline/--candidate)", () => {
  let dir: string;
  const write = (name: string, content: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-scorecard-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 and prints a human scorecard when nothing regresses", async () => {
    const baseline = write("baseline.json", JSON.stringify(summary()));
    const candidate = write("candidate-ok.json", JSON.stringify(summary({ elapsedMs: 1100, rounds: 3 })));
    const r = await runCli(["--baseline", baseline, "--candidate", candidate]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Run scorecard (oh-my-cli.scorecard v1)");
    expect(r.stdout).toContain("no regression detected (exit 0)");
    expect(r.stdout).not.toContain("[REGRESSION]");
  });

  it("exits 1 and flags a regression for a degraded candidate", async () => {
    const baseline = write("baseline2.json", JSON.stringify(summary({ toolFailures: {} })));
    const candidate = write("candidate-bad.json", JSON.stringify(summary({
      ok: false,
      reason: "error",
      toolFailures: { shell: 3 },
      elapsedMs: 3000,
    })));
    const r = await runCli(["--baseline", baseline, "--candidate", candidate]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Result: REGRESSION (exit 1)");
    expect(r.stdout).toContain("[REGRESSION]");
  });

  it("emits a machine-readable JSON scorecard and preserves the regression exit code", async () => {
    const baseline = write("baseline3.json", JSON.stringify(summary({ toolFailures: {} })));
    const candidate = write("candidate-json.json", JSON.stringify(summary({ toolFailures: { shell: 2 } })));
    const r = await runCli(["--baseline", baseline, "--candidate", candidate, "--output", "json"]);
    expect(r.code).toBe(1);
    const sc = JSON.parse(r.stdout.trim());
    expect(sc.schema).toBe("oh-my-cli.scorecard");
    expect(sc.v).toBe(1);
    expect(sc.regression).toBe(true);
    expect(sc.failuresRegressed).toBe(true);
    expect(Array.isArray(sc.rows)).toBe(true);
  });

  it("accepts a headless NDJSON stream and extracts its summary event", async () => {
    const stream = [
      JSON.stringify({ type: "start", sessionId: "s", model: "m", prompt: "hi" }),
      JSON.stringify({ type: "summary", summary: summary({ rounds: 4 }) }),
      JSON.stringify({ type: "complete", ok: true, exitCode: 0, rounds: 4, reason: "completed" }),
    ].join("\n");
    const baseline = write("stream-base.jsonl", stream);
    const candidate = write("stream-cand.jsonl", stream);
    const r = await runCli(["--baseline", baseline, "--candidate", candidate]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no regression detected");
  });

  it("honours a custom failure-delta threshold so a small increase is not a regression", async () => {
    const baseline = write("baseline4.json", JSON.stringify(summary({ toolFailures: {} })));
    const candidate = write("candidate-delta.json", JSON.stringify(summary({ toolFailures: { shell: 2 } })));
    const r = await runCli([
      "--baseline", baseline,
      "--candidate", candidate,
      "--max-failure-delta", "5",
      "--output", "json",
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).failuresRegressed).toBe(false);
  });

  it("exits 2 with an actionable message when --candidate is missing", async () => {
    const baseline = write("baseline5.json", JSON.stringify(summary()));
    const r = await runCli(["--baseline", baseline]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("requires both --baseline <file> and --candidate <file>");
  });

  it("exits 2 with an actionable message for a malformed summary", async () => {
    const baseline = write("baseline6.json", JSON.stringify(summary()));
    const candidate = write("candidate-malformed.json", JSON.stringify({ ...summary(), elapsedMs: "soon" }));
    const r = await runCli(["--baseline", baseline, "--candidate", candidate]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Malformed run summary in candidate");
  });

  it("exits 2 for a version-incompatible summary", async () => {
    const baseline = write("baseline7.json", JSON.stringify(summary()));
    const candidate = write("candidate-v2.json", JSON.stringify({ ...summary(), v: 2 }));
    const r = await runCli(["--baseline", baseline, "--candidate", candidate]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Incompatible run summary in candidate");
  });

  it("exits 2 for a missing input file", async () => {
    const baseline = write("baseline8.json", JSON.stringify(summary()));
    const r = await runCli(["--baseline", baseline, "--candidate", path.join(dir, "nope.json")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("file not found");
  });

  it("never leaks session ids or paths from the inputs into the output", async () => {
    const baseline = write("baseline9.json", JSON.stringify(summary({
      sessionId: "sess-SECRET-baseline",
      sessionPath: "/home/alice/secret-base.jsonl",
    })));
    const candidate = write("candidate9.json", JSON.stringify(summary({
      ok: false,
      sessionId: "sess-SECRET-candidate",
      sessionPath: "/home/bob/secret-cand.jsonl",
    })));
    const text = await runCli(["--baseline", baseline, "--candidate", candidate]);
    const json = await runCli(["--baseline", baseline, "--candidate", candidate, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain("sess-SECRET");
    expect(combined).not.toContain("/home/alice");
    expect(combined).not.toContain("/home/bob");
  });
});
