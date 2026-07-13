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

describe("Integration: session persistence and resume", () => {
  let server: FakeServer;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-session-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("persists session as JSONL and can resume", async () => {
    server.setResponses([
      { type: "text", content: "First response" },
    ]);

    // First run
    const result1 = await runCli(["-p", "Hello first time"], baseEnv);
    expect(result1.stdout).toContain("First response");
    expect(result1.code).toBe(0);

    // Check that session file was created
    const sessDir = path.join(sessionDir, ".oh-my-cli", "sessions");
    const files = fs.readdirSync(sessDir);
    expect(files.length).toBeGreaterThan(0);

    const sessionFile = files[0];
    const sessionId = sessionFile.replace(".jsonl", "");

    // Read the JSONL and verify structure
    const lines = fs.readFileSync(path.join(sessDir, sessionFile), "utf-8")
      .split("\n")
      .filter(Boolean);

    const messages = lines.map((l) => JSON.parse(l));
    expect(messages.some((m: { role: string }) => m.role === "system")).toBe(true);
    expect(messages.some((m: { role: string; content: string }) => m.role === "user" && m.content === "Hello first time")).toBe(true);
    expect(messages.some((m: { role: string; content: string }) => m.role === "assistant" && m.content === "First response")).toBe(true);

    // Resume with the session
    server.setResponses([
      { type: "text", content: "Resumed response" },
    ]);

    const result2 = await runCli(
      ["--resume", sessionId, "-p", "Continue our conversation"],
      baseEnv,
    );

    expect(result2.stdout).toContain("Resumed response");
  });

  it("tolerates incomplete trailing JSONL line", async () => {
    const sessDir = path.join(sessionDir, ".oh-my-cli", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });

    const sessionId = "test-incomplete";
    const filePath = path.join(sessDir, `${sessionId}.jsonl`);
    // Write valid line + incomplete trailing line
    fs.writeFileSync(filePath,
      JSON.stringify({ role: "user", content: "test" }) + "\n" +
      '{"role":"assistant","content":"incomplete' + "\n",
    );

    server.setResponses([
      { type: "text", content: "Recovered from crash" },
    ]);

    const result = await runCli(
      ["--resume", sessionId, "-p", "Continue after crash"],
      baseEnv,
    );

    expect(result.stdout).toContain("Recovered from crash");
  });
});
