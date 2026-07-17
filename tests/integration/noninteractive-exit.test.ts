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

// The plain-text run summary prints an "exit code: N" line; parse it so we can
// assert the process exit code agrees with the reported field.
function summaryExitCode(stdout: string): number | null {
  const m = stdout.match(/exit code:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

describe("Integration: non-interactive (-p) exit code", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-exit-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-exit-sess-"));
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

  it("exits non-zero when a plain -p run fails (provider error)", async () => {
    server.setResponses([{ failWith: { status: 400 } }]);
    const r = await runCli(["-p", "hello", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
  });

  it("exits 0 when a plain -p run succeeds", async () => {
    server.setResponses([{ type: "text", content: "ok" }]);
    const r = await runCli(["-p", "hello", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(0);
  });

  it("matches the process exit code to the --summary field on failure", async () => {
    server.setResponses([{ failWith: { status: 400 } }]);
    const r = await runCli(["-p", "hello", "--summary", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
    expect(summaryExitCode(r.stdout)).toBe(1);
    expect(summaryExitCode(r.stdout)).toBe(r.code);
  });

  it("matches the process exit code to the --summary field on success", async () => {
    server.setResponses([{ type: "text", content: "ok" }]);
    const r = await runCli(["-p", "hello", "--summary", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(0);
    expect(summaryExitCode(r.stdout)).toBe(0);
    expect(summaryExitCode(r.stdout)).toBe(r.code);
  });

  it("leaves the headless JSON exit behavior unchanged on failure", async () => {
    server.setResponses([{ failWith: { status: 400 } }]);
    const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], baseEnv);
    expect(r.code).toBe(1);
  });
});
