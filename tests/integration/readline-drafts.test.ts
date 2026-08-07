import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Durable composer drafts (Issue #725) live on the interactive readline
// surface only. Headless runs must never create, read, or clear a draft —
// the same boundary as prompt history (#723) and the session commands
// (#713).
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

describe("Integration: composer drafts headless boundary (Issue #725)", () => {
  let server: FakeServer;
  let homeDir: string;
  let workspace: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-725-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omc-725-ws-"));
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
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("a headless -p run never creates a draft file", async () => {
    server.setResponse({ type: "text", content: "headless answer" });
    const r = await runCli(["-p", "a headless prompt", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("headless answer");
    expect(fs.existsSync(path.join(homeDir, ".oh-my-cli", "drafts"))).toBe(false);
  });
});
