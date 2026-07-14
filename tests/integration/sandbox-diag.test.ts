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
  timeoutMs = 10_000,
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

describe("Integration: sandbox diagnostic", () => {
  let server: FakeServer;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-sandbox-"));
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

  it("shows sandbox info with --sandbox-info", async () => {
    const result = await runCli(["--sandbox-info"], baseEnv);
    expect(result.stdout).toContain("Sandbox Diagnostic");
    expect(result.stdout).toContain("headless");
    expect(result.stdout).toContain("default");
    expect(result.code).toBe(0);
  });

  it("shows yolo warning with --sandbox-info --approval-mode yolo", async () => {
    const result = await runCli(["--sandbox-info", "--approval-mode", "yolo"], baseEnv);
    expect(result.stdout).toContain("Yolo");
    expect(result.stdout).toContain("auto-approved");
  });

  it("emits no environment values or secrets", async () => {
    const result = await runCli(["--sandbox-info"], {
      ...baseEnv,
      OPENAI_API_KEY: "super-secret-test-value",
    });
    expect(result.stdout).not.toContain("super-secret-test-value");
    expect(result.stdout).not.toContain("fake-key");
  });

  it("shows --sandbox-info in help", async () => {
    const result = await runCli(["--help"], baseEnv);
    expect(result.stdout).toContain("--sandbox-info");
  });
});
