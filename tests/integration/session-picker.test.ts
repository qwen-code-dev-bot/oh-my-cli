import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    // No PTY: stdin/stdout are pipes, so the interactive picker must fail closed.
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

describe("Integration: --browse-sessions interactive picker", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-browse-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("fails closed without a terminal instead of hanging", async () => {
    const r = await runCli(["--browse-sessions"], baseEnv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--browse-sessions requires an interactive terminal");
  });

  it("does not create or mutate any session when rejected", async () => {
    const sessDir = path.join(homeDir, ".oh-my-cli", "sessions");
    const before = fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : [];
    await runCli(["--browse-sessions"], baseEnv);
    const after = fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : [];
    expect(after).toEqual(before);
  });
});
