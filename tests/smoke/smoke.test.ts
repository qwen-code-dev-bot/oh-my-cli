import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";

function runCli(args: string[], env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
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

describe("smoke: built CLI binary with fake provider", () => {
  let server: FakeServer;

  beforeAll(async () => {
    server = await createFakeServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("responds to -p with streamed text from fake provider", async () => {
    server.setResponse({ type: "text", content: "Hello from smoke test" });

    const result = await runCli(["-p", "Say hello"], {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
    });

    expect(result.stdout).toContain("Hello from smoke test");
    expect(result.code).toBe(0);
  });

  it("exits with error when OPENAI_API_KEY is missing", async () => {
    const result = await runCli(["-p", "test"], {
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
    });

    expect(result.stderr).toContain("Configuration error");
    expect(result.code).not.toBe(0);
  });

  it("shows --help", async () => {
    const result = await runCli(["--help"], {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
    });

    expect(result.stdout).toContain("oh-my-cli");
    expect(result.stdout).toContain("--prompt");
    expect(result.stdout).toContain("--resume");
    expect(result.stdout).toContain("--approval-mode");
    expect(result.stdout).toContain("yolo");
  });
});
