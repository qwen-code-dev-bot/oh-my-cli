import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Matches any ANSI CSI escape (SGR color, cursor control, etc.).
const ANSI = /\x1b\[/;

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

describe("Integration: --no-color and NO_COLOR plain output", () => {
  let server: FakeServer;
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-no-color-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("emits no ANSI escapes for a successful command with --no-color", async () => {
    server.setResponse({ type: "text", content: "plain success" });
    const r = await runCli(["--no-color", "-p", "Hello"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plain success");
    expect(r.stdout).not.toMatch(ANSI);
    expect(r.stderr).not.toMatch(ANSI);
  });

  it("emits no ANSI escapes when NO_COLOR=1 is set (equivalent to --no-color)", async () => {
    server.setResponse({ type: "text", content: "plain success" });
    const r = await runCli(["-p", "Hello"], { ...baseEnv, NO_COLOR: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plain success");
    expect(r.stdout).not.toMatch(ANSI);
    expect(r.stderr).not.toMatch(ANSI);
  });

  it("preserves exit code and useful error text for a failing command with --no-color", async () => {
    // A missing API key is a configuration error: non-zero exit, actionable text.
    const r = await runCli(["--no-color", "-p", "Hello"], {
      ...baseEnv,
      OPENAI_API_KEY: "",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Configuration error");
    expect(r.stderr).not.toMatch(ANSI);
    expect(r.stdout).not.toMatch(ANSI);
  });

  it("accepts --no-color alongside a diagnostic command and stays plain", async () => {
    const r = await runCli(["--no-color", "--doctor"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).not.toMatch(ANSI);
    expect(r.stderr).not.toMatch(ANSI);
  });
});
