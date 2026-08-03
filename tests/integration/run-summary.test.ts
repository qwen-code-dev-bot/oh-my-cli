import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

describe("Integration: run summary (--summary)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summary-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summary-sess-"));
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

  it("prints a privacy-safe summary after a successful text run only when requested", async () => {
    server.setResponses([{ type: "text", content: "Done" }]);
    const withSummary = await runCli(["-p", "hello", "--summary", "--workspace", tmpDir], baseEnv);
    expect(withSummary.code).toBe(0);
    expect(withSummary.stdout).toContain("Run summary (oh-my-cli.summary v1)");
    expect(withSummary.stdout).toContain("outcome:   success");
    expect(withSummary.stdout).toContain("reason:    completed");
    expect(withSummary.stdout).toContain("evidence:  session ");
    // The host home directory is collapsed, never leaked.
    expect(withSummary.stdout).not.toContain(sessionDir);
    expect(withSummary.stdout).toContain("~/.oh-my-cli/sessions/");

    server.setResponses([{ type: "text", content: "Done" }]);
    const plain = await runCli(["-p", "hello", "--workspace", tmpDir], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("Run summary (oh-my-cli.summary v1)");
  });

  it("emits a summary event with bounded activity and token totals in the JSON stream", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "shell", arguments: JSON.stringify({ command: "echo hi" }) }],
      },
      { type: "text", content: "Completed" },
    ]);

    const r = await runCli(
      ["-p", "do work", "--output", "json", "--summary", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const summaryRec = recs.find((x) => x.type === "summary");
    expect(summaryRec).toBeDefined();
    if (summaryRec?.type === "summary") {
      const s = summaryRec.summary;
      expect(s.schema).toBe("oh-my-cli.summary");
      expect(s.v).toBe(1);
      expect(s.outcome).toBe("success");
      expect(s.exitCode).toBe(0);
      expect(s.reason).toBe("completed");
      expect(typeof s.elapsedMs).toBe("number");
      expect(s.rounds).toBe(2);
      expect(s.toolCalls.byName).toEqual({ shell: 1 });
      expect(s.toolCalls.total).toBe(1);
      // Two rounds, each reporting fixed usage (10 total) → 20.
      expect(s.tokens).toEqual({ prompt: 10, completion: 10, total: 20 });
      expect(s.evidence.sessionId).toBeTruthy();
    }

    // The terminal complete record is still present and matches the exit code.
    const complete = recs.find((x) => x.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") expect(complete.exitCode).toBe(r.code);
  });

  it("keeps secret-shaped prompt content out of the summary", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "shell", arguments: JSON.stringify({ command: "echo ok" }) }],
      },
      { type: "text", content: "Completed" },
    ]);

    const r = await runCli(
      ["-p", `my api key is ${secret}`, "--output", "json", "--summary", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);

    const recs = parseHeadlessStream(r.stdout);
    const summaryRec = recs.find((x) => x.type === "summary");
    expect(summaryRec).toBeDefined();
    // The summary is metadata only: the secret never appears in it.
    expect(JSON.stringify(summaryRec)).not.toContain(secret);
  });

  it("classifies a budget-exhausted run with the same schema and a failing exit code", async () => {
    const responses = [];
    for (let i = 0; i < 31; i++) {
      responses.push({
        type: "tool_calls" as const,
        toolCalls: [{ id: `call_${i}`, name: "shell", arguments: JSON.stringify({ command: `echo ${i}` }) }],
      });
    }
    server.setResponses(responses);

    const r = await runCli(
      ["-p", "keep going", "--output", "json", "--summary", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
      30_000,
    );
    expect(r.code).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    const summaryRec = recs.find((x) => x.type === "summary");
    expect(summaryRec).toBeDefined();
    if (summaryRec?.type === "summary") {
      const s = summaryRec.summary;
      expect(s.outcome).toBe("failure");
      expect(s.exitCode).toBe(1);
      expect(s.reason).toBe("max_rounds");
      expect(s.rounds).toBe(30);
      expect(s.toolCalls.byName).toEqual({ shell: 30 });
    }
  });
});

describe("Integration: run summary on provider failure", () => {
  let httpServer: http.Server;
  let serverUrl: string;
  let sessionDir: string;
  let tmpDir: string;

  beforeAll(async () => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summary-fail-sess-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summary-fail-"));
    httpServer = http.createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal server error" } }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a failing summary and preserves the process exit code", async () => {
    const r = await runCli(
      ["-p", "boom", "--output", "json", "--summary", "--workspace", tmpDir],
      {
        OPENAI_API_KEY: "fake-key",
        OPENAI_BASE_URL: serverUrl,
        OPENAI_MODEL: "fake-model",
        HOME: sessionDir,
      },
    );
    expect(r.code).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    const summaryRec = recs.find((x) => x.type === "summary");
    expect(summaryRec).toBeDefined();
    if (summaryRec?.type === "summary") {
      const s = summaryRec.summary;
      expect(s.outcome).toBe("failure");
      expect(s.exitCode).toBe(1);
      expect(s.reason).toBe("provider_error");
    }
    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") expect(complete.exitCode).toBe(r.code);
  });
});

describe("Integration: persist run summaries (--summary-out, Issue #519)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summaryout-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-summaryout-sess-"));
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

  it("persists a scorecard-readable summary file without touching stdout", async () => {
    const { readRunSummaryFile } = await import("../../src/run-scorecard.js");
    server.setResponses([{ type: "text", content: "Done" }]);
    const file = path.join(tmpDir, "run-a.summary.json");
    const r = await runCli(
      ["-p", "hello", "--summary-out", file, "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    // Independent of --summary: nothing is printed without it.
    expect(r.stdout).not.toContain("Run summary (oh-my-cli.summary v1)");

    const parsed = readRunSummaryFile(file, "integration");
    expect(parsed.schema).toBe("oh-my-cli.summary");
    expect(parsed.v).toBe(1);
    expect(parsed.outcome).toBe("success");
    expect(parsed.reason).toBe("completed");
    expect(parsed.rounds).toBe(1);
    expect(parsed.evidence.sessionId).toBeTruthy();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("refuses to overwrite without --force, replaces with it", async () => {
    const { readRunSummaryFile } = await import("../../src/run-scorecard.js");
    const file = path.join(tmpDir, "run-b.summary.json");

    server.setResponses([{ type: "text", content: "Done" }]);
    const first = await runCli(["-p", "hello", "--summary-out", file, "--workspace", tmpDir], baseEnv);
    expect(first.code).toBe(0);
    const firstSession = readRunSummaryFile(file, "first").evidence.sessionId;

    server.setResponses([{ type: "text", content: "Done" }]);
    const refused = await runCli(["-p", "hello", "--summary-out", file, "--workspace", tmpDir], baseEnv);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Refusing to overwrite existing run summary");
    expect(refused.stderr).toContain("--force");
    // The first artifact survived untouched.
    expect(readRunSummaryFile(file, "survived").evidence.sessionId).toBe(firstSession);

    server.setResponses([{ type: "text", content: "Done" }]);
    const forced = await runCli(
      ["-p", "hello", "--summary-out", file, "--force", "--workspace", tmpDir],
      baseEnv,
    );
    expect(forced.code).toBe(0);
    const replaced = readRunSummaryFile(file, "replaced");
    expect(replaced.reason).toBe("completed");
    expect(replaced.evidence.sessionId).not.toBe(firstSession);
  });

  it("fails closed when the parent directory does not exist", async () => {
    const file = path.join(tmpDir, "no-such-dir", "run.summary.json");
    server.setResponses([{ type: "text", content: "Done" }]);
    const r = await runCli(["-p", "hello", "--summary-out", file, "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot write run summary");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("persists the summary of a failing run too", async () => {
    const { readRunSummaryFile } = await import("../../src/run-scorecard.js");
    const file = path.join(tmpDir, "run-fail.summary.json");
    server.setResponse({ type: "text", content: "unused", failWith: { status: 400 } });
    const r = await runCli(["-p", "boom", "--summary-out", file, "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
    const parsed = readRunSummaryFile(file, "failed-run");
    expect(parsed.outcome).toBe("failure");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.reason).toBe("provider_error");
  });
});
