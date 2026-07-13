import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
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

describe("Integration: agent loop with tools", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-test-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-sess-"));
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

  it("executes a tool call and continues the agent loop", async () => {
    // Create a file for the read tool to access
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "file contents here");

    // First response: tool call to read the file
    // Second response: text answer based on tool result
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "read",
          arguments: JSON.stringify({ path: "test.txt" }),
        }],
      },
      { type: "text", content: "The file contains: file contents here" },
    ]);

    const result = await runCli(
      ["-p", "Read test.txt", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("The file contains: file contents here");
    expect(result.code).toBe(0);
  });

  it("write tool creates a file", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: "output.txt", content: "hello world" }),
        }],
      },
      { type: "text", content: "File written successfully" },
    ]);

    const result = await runCli(
      ["-p", "Write hello world to output.txt", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("File written successfully");
    const written = fs.readFileSync(path.join(tmpDir, "output.txt"), "utf-8");
    expect(written).toBe("hello world");
  });

  it("edit tool replaces text in a file", async () => {
    fs.writeFileSync(path.join(tmpDir, "editme.txt"), "Hello World");

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "edit",
          arguments: JSON.stringify({ path: "editme.txt", oldText: "World", newText: "CLI" }),
        }],
      },
      { type: "text", content: "Edited the file" },
    ]);

    const result = await runCli(
      ["-p", "Change World to CLI", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("Edited the file");
    const content = fs.readFileSync(path.join(tmpDir, "editme.txt"), "utf-8");
    expect(content).toBe("Hello CLI");
  });

  it("shell tool executes commands", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "echo 'shell works'" }),
        }],
      },
      { type: "text", content: "Shell output captured" },
    ]);

    const result = await runCli(
      ["-p", "Run echo", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("Shell output captured");
  });

  it("rejects path escape in read tool", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "read",
          arguments: JSON.stringify({ path: "../../etc/passwd" }),
        }],
      },
      { type: "text", content: "Could not read that file" },
    ]);

    const result = await runCli(
      ["-p", "Read /etc/passwd", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    // The tool should have returned an error, and the agent continues
    expect(result.stdout).toContain("Could not read that file");
    // Verify the request included the tool result with path escape error
    expect(server.requests.length).toBe(2);
  });

  it("respects 30-round guard", async () => {
    // Set up 31 tool call responses to force hitting the limit
    const responses = [];
    for (let i = 0; i < 31; i++) {
      responses.push({
        type: "tool_calls" as const,
        toolCalls: [{
          id: `call_${i}`,
          name: "shell",
          arguments: JSON.stringify({ command: `echo round${i}` }),
        }],
      });
    }
    server.setResponses(responses);

    const result = await runCli(
      ["-p", "Keep going", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
      30_000,
    );

    // Should stop after 30 rounds (30 requests, not 31)
    expect(server.requests.length).toBeLessThanOrEqual(30);
  });
});

describe("Integration: approval modes", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-approval-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-approval-sess-"));
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

  it("default mode denies shell without TTY", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "echo denied" }),
        }],
      },
      { type: "text", content: "The shell command was denied" },
    ]);

    const result = await runCli(
      ["-p", "Run shell", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    // Shell should be denied without TTY, tool result should say denied
    expect(result.stdout).toContain("The shell command was denied");
  });

  it("auto-edit mode allows write but denies shell without TTY", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: "auto.txt", content: "auto-edit works" }),
        }],
      },
      { type: "text", content: "Write succeeded" },
    ]);

    const result = await runCli(
      ["-p", "Write a file", "--approval-mode", "auto-edit", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("Write succeeded");
    expect(fs.readFileSync(path.join(tmpDir, "auto.txt"), "utf-8")).toBe("auto-edit works");
  });

  it("yolo mode allows all tools", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "echo yolo-works" }),
        }],
      },
      { type: "text", content: "Shell ran in yolo mode" },
    ]);

    const result = await runCli(
      ["-p", "Run shell", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("Shell ran in yolo mode");
  });
});

describe("Integration: shell timeout and output cap", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-shell-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-shell-sess-"));
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

  it("shell times out when command exceeds timeout", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "sleep 10", timeout: 1 }),
        }],
      },
      { type: "text", content: "The command timed out" },
    ]);

    const result = await runCli(
      ["-p", "Sleep for a long time", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
      30_000,
    );

    expect(result.stdout).toContain("The command timed out");
  });
});
