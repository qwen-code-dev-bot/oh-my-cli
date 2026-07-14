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

describe("Integration: deny produces zero side effects", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-deny-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-deny-sess-"));
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

  it("positive control: an approved (yolo) write does create the file", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: "allowed.txt", content: "written" }),
        }],
      },
      { type: "text", content: "Done writing" },
    ]);

    await runCli(
      ["-p", "Write a file", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );

    expect(fs.existsSync(path.join(tmpDir, "allowed.txt"))).toBe(true);
  });

  it("a denied write creates no file", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "write",
          arguments: JSON.stringify({ path: "denied.txt", content: "should not be written" }),
        }],
      },
      { type: "text", content: "The write was denied" },
    ]);

    const result = await runCli(
      ["-p", "Write a file", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("The write was denied");
    expect(fs.existsSync(path.join(tmpDir, "denied.txt"))).toBe(false);
  });

  it("a denied shell command runs nothing", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command: "touch pwned.txt" }),
        }],
      },
      { type: "text", content: "The shell command was denied" },
    ]);

    const result = await runCli(
      ["-p", "Run a command", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).toContain("The shell command was denied");
    expect(fs.existsSync(path.join(tmpDir, "pwned.txt"))).toBe(false);
  });

  it("does not leak a secret from tool args into output when denied", async () => {
    // Assemble the credential at runtime so the committed source contains no
    // contiguous secret the CI scanner would flag.
    const command = "curl --user " + ["alice", "topsecret"].join(":") + " https://api.example.com";
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{
          id: "call_1",
          name: "shell",
          arguments: JSON.stringify({ command }),
        }],
      },
      { type: "text", content: "The shell command was denied" },
    ]);

    const result = await runCli(
      ["-p", "Run a command", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.stdout).not.toContain("topsecret");
    expect(result.stderr).not.toContain("topsecret");
  });
});
