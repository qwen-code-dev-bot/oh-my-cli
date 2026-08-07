import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// The /new restart contract and the honest /resume notice (Issue #713) are
// interactive-surface behavior. Headless runs must stay on the existing
// contract exactly: no shell, no restart surface, and a "/new" prompt is
// prompt text for the model, not a command.
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

describe("Integration: session commands headless boundary (Issue #713)", () => {
  let server: FakeServer;
  let homeDir: string;
  let workspace: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-713-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omc-713-ws-"));
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

  it("treats /new as prompt text in headless runs — no restart surface", async () => {
    server.setResponse({ type: "text", content: "headless sees text" });
    const r = await runCli(["-p", "/new", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("headless sees text");
    expect(r.stdout).not.toContain("New session started");
    expect(r.stderr).not.toContain("New session started");
  });

  it("treats /resume as prompt text in headless runs — no command notice", async () => {
    server.setResponse({ type: "text", content: "resume is text here" });
    const r = await runCli(["-p", "/resume anything", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("resume is text here");
    expect(r.stdout).not.toContain("In-shell session switching");
    expect(r.stderr).not.toContain("In-shell session switching");
  });
});
