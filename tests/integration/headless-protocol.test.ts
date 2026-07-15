import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream, parseHeadlessLine, terminalRecord } from "../../src/headless-protocol.js";
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

describe("Integration: headless JSON protocol", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-headless-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-headless-sess-"));
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

  it("emits a clean stream for a successful run with terminal exit semantics", async () => {
    server.setResponses([{ type: "text", content: "Hello from headless" }]);

    const r = await runCli(
      ["-p", "Say hello", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    // Every stdout line parses independently as a protocol record (pure stream).
    const recs = parseHeadlessStream(r.stdout);
    expect(recs[0].type).toBe("start");
    if (recs[0].type === "start") {
      expect(recs[0].model).toBe("fake-model");
      expect(recs[0].prompt).toBe("Say hello");
    }

    const assistant = recs.find((x) => x.type === "assistant");
    expect(assistant).toBeDefined();
    if (assistant?.type === "assistant") {
      expect(assistant.text).toContain("Hello from headless");
      expect(assistant.final).toBe(true);
    }

    // Dogfood: the terminal record's exitCode matches the process exit code.
    const term = terminalRecord(recs);
    expect(term).not.toBeNull();
    expect(term!.ok).toBe(true);
    if (term && term.type === "complete") {
      expect(term.reason).toBe("completed");
      expect(term.exitCode).toBe(r.code);
    }
  });

  it("reports a tool failure in-stream while the run still completes", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "hello");
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_edit",
          name: "edit",
          arguments: JSON.stringify({ path: "f.txt", oldText: "ZZZ", newText: "Y" }),
        }],
      },
      { type: "text", content: "I could not make that edit" },
    ]);

    const r = await runCli(
      ["-p", "Edit f.txt", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    const recs = parseHeadlessStream(r.stdout);

    const start = recs.find((x) => x.type === "tool_start");
    const result = recs.find((x) => x.type === "tool_result");
    expect(start).toBeDefined();
    expect(result).toBeDefined();
    if (start?.type === "tool_start" && result?.type === "tool_result") {
      expect(start.id).toBe(result.id);
      expect(start.name).toBe("edit");
      expect(result.ok).toBe(false);
      expect(result.content).toContain("oldText not found");
    }

    // A tool failure is observable but not a process failure.
    const term = terminalRecord(recs);
    expect(term!.ok).toBe(true);
    if (term && term.type === "complete") {
      expect(term.exitCode).toBe(0);
      expect(term.exitCode).toBe(r.code);
    }
  });

  it("reports elapsed wall-clock time for a shell tool result", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_sleep",
          name: "shell",
          arguments: JSON.stringify({ command: "sleep 0.3" }),
        }],
      },
      { type: "text", content: "Done sleeping" },
    ]);

    const r = await runCli(
      ["-p", "Sleep briefly", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    const recs = parseHeadlessStream(r.stdout);
    const result = recs.find((x) => x.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") {
      expect(result.name).toBe("shell");
      expect(result.ok).toBe(true);
      // Elapsed time is available to headless consumers and reflects real time.
      expect(typeof result.elapsedMs).toBe("number");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    }
  });

  it("keeps default output unchanged when the protocol is not selected", async () => {
    server.setResponses([{ type: "text", content: "Plain text answer" }]);

    const r = await runCli(["-p", "hello", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Plain text answer");
    // The default stream is human text, not a protocol record.
    expect(() => parseHeadlessLine(r.stdout.trim())).toThrow();
  });

  it("rejects an unknown output format", async () => {
    const r = await runCli(["-p", "hello", "--output", "yaml", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid output format");
  });
});

describe("Integration: headless JSON protocol process failure", () => {
  let httpServer: http.Server;
  let serverUrl: string;
  let sessionDir: string;
  let tmpDir: string;

  beforeAll(async () => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-headless-fail-sess-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-headless-fail-"));
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

  it("emits an error record and a failing terminal record matching the exit code", async () => {
    const r = await runCli(
      ["-p", "boom", "--output", "json", "--workspace", tmpDir],
      {
        OPENAI_API_KEY: "fake-key",
        OPENAI_BASE_URL: serverUrl,
        OPENAI_MODEL: "fake-model",
        HOME: sessionDir,
      },
    );

    expect(r.code).toBe(1);
    const recs = parseHeadlessStream(r.stdout);

    const err = recs.find((x) => x.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") expect(err.stage).toBe("provider");

    const term = terminalRecord(recs);
    expect(term).not.toBeNull();
    expect(term!.ok).toBe(false);
    if (term && term.type === "complete") {
      expect(term.reason).toBe("provider_error");
      expect(term.exitCode).toBe(1);
      // Dogfood: terminal record exit semantics equal the process exit code.
      expect(term.exitCode).toBe(r.code);
    }
  });
});
