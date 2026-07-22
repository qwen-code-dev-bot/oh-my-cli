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

function writeCall(id: string, fileName: string) {
  return {
    id,
    name: "write",
    arguments: JSON.stringify({ path: fileName, content: "hi" }),
  };
}

function shellCall(id: string, command: string) {
  return {
    id,
    name: "shell",
    arguments: JSON.stringify({ command }),
  };
}

describe("Integration: bottleneck report (--bottleneck)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-bottleneck-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-bottleneck-sess-"));
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

  it("prints a bottleneck report after a text run only when requested", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [shellCall("call_1", "echo hi")] },
      { type: "text", content: "Done" },
    ]);
    const withReport = await runCli(
      ["-p", "do work", "--bottleneck", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(withReport.code).toBe(0);
    expect(withReport.stdout).toContain("Bottleneck report (oh-my-cli.bottleneck v1)");
    expect(withReport.stdout).toContain("tool shell");

    server.setResponses([
      { type: "tool_calls", toolCalls: [shellCall("call_1", "echo hi")] },
      { type: "text", content: "Done" },
    ]);
    const plain = await runCli(
      ["-p", "do work", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("Bottleneck report (oh-my-cli.bottleneck v1)");
  });

  it("emits a bottleneck event with a tool entry in the JSON stream", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [shellCall("call_1", "echo hi")] },
      { type: "text", content: "Completed" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--bottleneck", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const bn = recs.find((x) => x.type === "bottleneck");
    expect(bn).toBeDefined();
    if (bn?.type === "bottleneck") {
      const report = bn.bottleneck;
      expect(report.schema).toBe("oh-my-cli.bottleneck");
      expect(report.v).toBe(1);
      expect(typeof report.elapsedMs).toBe("number");
      const shell = report.entries.find((e) => e.kind === "tool" && e.name === "shell");
      expect(shell).toBeDefined();
      expect(shell!.calls).toBe(1);
      expect(shell!.wallMs).toBeGreaterThanOrEqual(0);
    }

    // The terminal complete record is still present and matches the exit code.
    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") expect(complete.exitCode).toBe(r.code);
  });

  it("ranks a deliberately slow tool above a fast one by wall-time", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [writeCall("call_1", "fast.txt")] },
      { type: "tool_calls", toolCalls: [shellCall("call_2", "sleep 0.3")] },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--bottleneck", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const bn = recs.find((x) => x.type === "bottleneck");
    expect(bn).toBeDefined();
    if (bn?.type === "bottleneck") {
      const report = bn.bottleneck;
      const shell = report.entries.find((e) => e.kind === "tool" && e.name === "shell");
      const write = report.entries.find((e) => e.kind === "tool" && e.name === "write");
      expect(shell).toBeDefined();
      expect(write).toBeDefined();
      // The slow shell command dominates wall-time and ranks first.
      expect(report.entries[0].name).toBe("shell");
      expect(shell!.wallMs).toBeGreaterThan(write!.wallMs);
    }
    expect(fs.existsSync(path.join(tmpDir, "fast.txt"))).toBe(true);
  });

  it("keeps secret-shaped tool arguments out of the bottleneck report", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "write", arguments: JSON.stringify({ path: "leak.txt", content: secret }) }],
      },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--bottleneck", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const bn = recs.find((x) => x.type === "bottleneck");
    expect(bn).toBeDefined();
    // The report is metadata only: the secret-bearing argument never appears in it.
    expect(JSON.stringify(bn)).not.toContain(secret);
  });

  it("reports an empty inventory for a run with no tool activity", async () => {
    server.setResponses([{ type: "text", content: "just text" }]);
    const r = await runCli(
      ["-p", "hello", "--bottleneck", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Bottleneck report (oh-my-cli.bottleneck v1)");
    expect(r.stdout).toContain("(no tool or approval activity recorded)");
  });
});
