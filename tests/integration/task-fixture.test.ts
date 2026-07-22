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
  timeoutMs = 20_000,
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

// The deterministic summary fields a reproducible replay must fix (everything
// except wall-time and the per-run session evidence pointers).
function deterministicFields(summary: Record<string, unknown>): unknown {
  const { elapsedMs: _e, evidence: _v, ...rest } = summary;
  void _e;
  void _v;
  return rest;
}

describe("Integration: task-fixture replay (--replay-fixture)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;
  let fixturePath: string;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-fixture-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-fixture-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
    fixturePath = path.join(tmpDir, "fixture.json");
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        schema: "oh-my-cli.task-fixture",
        version: 1,
        prompt: "write a file",
        script: [
          {
            type: "tool_calls",
            toolCalls: [{ id: "c1", name: "write", arguments: JSON.stringify({ path: "replay.txt", content: "hi" }) }],
          },
          { type: "text", content: "done" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  function replay(): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return runCli(
      [
        "--replay-fixture", fixturePath,
        "--output", "json",
        "--summary",
        "--approval-mode", "yolo",
        "--workspace", tmpDir,
      ],
      baseEnv,
    );
  }

  it("replays a fixture deterministically: two replays yield identical summaries", async () => {
    const r1 = await replay();
    expect(r1.code).toBe(0);
    const r2 = await replay();
    expect(r2.code).toBe(0);

    const s1 = parseHeadlessStream(r1.stdout).find((x) => x.type === "summary");
    const s2 = parseHeadlessStream(r2.stdout).find((x) => x.type === "summary");
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    if (s1?.type === "summary" && s2?.type === "summary") {
      // The deterministic fields match exactly across the two replays.
      expect(deterministicFields(s1.summary as unknown as Record<string, unknown>)).toEqual(
        deterministicFields(s2.summary as unknown as Record<string, unknown>),
      );
      // The fixture's scripted tool call is reflected in the summary.
      const sum = s1.summary as unknown as { toolCalls: { byName: Record<string, number> }; outcome: string };
      expect(sum.outcome).toBe("success");
      expect(sum.toolCalls.byName).toEqual({ write: 1 });
    }
    // The replay never hit the network provider (the fixture provider drove it).
    expect(server.requests.length).toBe(0);
    // The scripted write actually ran.
    expect(fs.existsSync(path.join(tmpDir, "replay.txt"))).toBe(true);
  });

  it("exits 2 (fail closed) on an unsupported fixture version", async () => {
    const bad = path.join(tmpDir, "bad-version.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 99, prompt: "x", script: [{ type: "text", content: "y" }] }));
    const r = await runCli(
      ["--replay-fixture", bad, "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 (fail closed) on a fixture carrying a raw credential field", async () => {
    const bad = path.join(tmpDir, "bad-secret.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({ version: 1, prompt: "x", script: [{ type: "text", content: "y" }], apiKey: "leaked" }),
    );
    const r = await runCli(
      ["--replay-fixture", bad, "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
  });

  it("exits 2 on a missing fixture file", async () => {
    const r = await runCli(
      ["--replay-fixture", path.join(tmpDir, "nope.json"), "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot read fixture file");
  });
});
