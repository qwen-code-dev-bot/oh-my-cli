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

describe("Integration: failure taxonomy (--failure-taxonomy)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-failure-tax-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-failure-tax-sess-"));
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

  it("prints a failure taxonomy after a text run only when requested", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "call_1", name: "nonexistent_tool", arguments: "{}" }] },
      { type: "text", content: "done" },
    ]);
    const withReport = await runCli(
      ["-p", "do work", "--failure-taxonomy", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(withReport.code).toBe(0);
    expect(withReport.stdout).toContain("Failure taxonomy (oh-my-cli.failure-taxonomy v1)");
    expect(withReport.stdout).toContain("unknown_tool");

    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "call_1", name: "nonexistent_tool", arguments: "{}" }] },
      { type: "text", content: "done" },
    ]);
    const plain = await runCli(
      ["-p", "do work", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("Failure taxonomy (oh-my-cli.failure-taxonomy v1)");
  });

  it("categorizes an unknown-tool failure in the JSON stream", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "call_1", name: "nonexistent_tool", arguments: "{}" }] },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--failure-taxonomy", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const ft = recs.find((x) => x.type === "failure_taxonomy");
    expect(ft).toBeDefined();
    if (ft?.type === "failure_taxonomy") {
      const report = ft.failureTaxonomy;
      expect(report.schema).toBe("oh-my-cli.failure-taxonomy");
      expect(report.v).toBe(1);
      expect(report.reason).toBe("completed");
      expect(report.totalFailures).toBe(1);
      expect(report.byCategory).toEqual({ unknown_tool: 1 });
    }
  });

  it("categorizes a path-escape write failure distinctly from a generic tool error", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "write", arguments: JSON.stringify({ path: "../../escape.txt", content: "hi" }) }],
      },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--failure-taxonomy", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const ft = recs.find((x) => x.type === "failure_taxonomy");
    expect(ft).toBeDefined();
    if (ft?.type === "failure_taxonomy") {
      expect(ft.failureTaxonomy.byCategory).toEqual({ path_escape: 1 });
    }
    // The escape write must not have created a file outside the workspace.
    expect(fs.existsSync(path.join(tmpDir, "../../escape.txt"))).toBe(false);
  });

  it("keeps secret-shaped tool arguments out of the failure taxonomy report", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "nonexistent_tool", arguments: JSON.stringify({ apiKey: secret }) }],
      },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--output", "json", "--failure-taxonomy", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const ft = recs.find((x) => x.type === "failure_taxonomy");
    expect(ft).toBeDefined();
    // The report is metadata only: the secret-bearing argument never appears in it.
    expect(JSON.stringify(ft)).not.toContain(secret);
  });

  it("reports zero failures for a clean run with no tool failures", async () => {
    server.setResponses([{ type: "text", content: "just text" }]);
    const r = await runCli(
      ["-p", "hello", "--failure-taxonomy", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Failure taxonomy (oh-my-cli.failure-taxonomy v1)");
    expect(r.stdout).toContain("failures:  0 (none)");
  });
});
