import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 30_000,
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

describe("Integration: workflow execution console (#262)", () => {
  let server: FakeServer;
  let home: string;
  let workspace: string;
  let settingsPath: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "omc-wf-console-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omc-wf-console-ws-"));
    settingsPath = path.join(home, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        workflows: {
          contractVersion: 1,
          definitions: {
            wf: { steps: [{ prompt: "step one" }, { prompt: "step two" }, { prompt: "step three" }] },
          },
        },
      }),
    );
    env = {
      HOME: home,
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("prints the run header before the first step, then per-step states, then the outcome (success)", async () => {
    server.setResponses([
      { type: "text", content: "one done" },
      { type: "text", content: "two done" },
      { type: "text", content: "three done" },
    ]);
    const r = await runCli(
      ["--run-workflow", "wf", "--settings", settingsPath, "--workspace", workspace, "--no-color"],
      env,
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);

    // Run header is the first line, before any step.
    expect(lines[0]).toContain('Workflow "wf" — 3 steps');

    // Each step shows a running line then a completed line, in order.
    const runningIdx = lines.map((l, i) => (l.includes("● running") ? i : -1)).filter((i) => i >= 0);
    const completedIdx = lines.map((l, i) => (l.includes("✓ completed") ? i : -1)).filter((i) => i >= 0);
    expect(runningIdx.length).toBe(3);
    expect(completedIdx.length).toBe(3);
    // The first running line precedes the first completed line.
    expect(runningIdx[0]).toBeLessThan(completedIdx[0]);
    expect(lines).toContainEqual(expect.stringContaining("Step 1/3"));
    expect(lines).toContainEqual(expect.stringContaining("Step 3/3"));

    // Terminal outcome with exact counts.
    expect(lines[lines.length - 1]).toContain("Result: completed (3/3 steps");

    // --no-color: no ANSI escapes anywhere.
    expect(r.stdout).not.toContain("\x1b[");
  });

  it("makes the failed step prominent, marks remaining steps skipped, and exits non-zero (halted)", async () => {
    server.setResponses([
      { type: "text", content: "one done" },
      { type: "text", failWith: { status: 400 } }, // step two fails immediately (non-retryable)
    ]);
    const r = await runCli(
      ["--run-workflow", "wf", "--settings", settingsPath, "--workspace", workspace, "--no-color"],
      env,
    );
    expect(r.code).toBe(1);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);

    // Run header first.
    expect(lines[0]).toContain('Workflow "wf" — 3 steps');

    // Step 1 completed; step 2 failed with a reason; step 3 skipped.
    expect(lines.some((l) => l.includes("✓ completed") && l.includes("Step 1/3"))).toBe(true);
    expect(lines.some((l) => l.includes("✗ failed") && l.includes("Step 2/3"))).toBe(true);
    expect(lines.some((l) => l.includes("reason:"))).toBe(true);
    expect(lines.some((l) => l.includes("- skipped") && l.includes("Steps 3-3 (halted)"))).toBe(true);

    // Terminal outcome reflects the halt with exact counts.
    expect(lines[lines.length - 1]).toContain("Result: failed (2/3 steps");
    expect(r.stdout).not.toContain("\x1b[");
  });
});
