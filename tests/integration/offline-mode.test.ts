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

describe("Integration: offline mode (--offline / OMC_OFFLINE, Issue #576)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-576i-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-576i-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url, // 127.0.0.1 — loopback
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
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  it("completes a turn against a loopback provider in offline mode", async () => {
    server.setResponses([{ type: "text", content: "LOCAL ANSWER" }]);
    const r = await runCli(
      ["-p", "hello offline", "--offline", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("LOCAL ANSWER");
    // The offline banner appears before the first provider request.
    expect(r.stderr).toContain("Offline mode: provider routes are restricted to loopback");
    expect(server.requests.length).toBe(1);
  });

  it("honors OMC_OFFLINE=1 exactly like the flag", async () => {
    server.setResponses([{ type: "text", content: "ENV ANSWER" }]);
    const r = await runCli(
      ["-p", "hello offline", "--approval-mode", "yolo", "--workspace", tmpDir],
      { ...baseEnv, OMC_OFFLINE: "1" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ENV ANSWER");
    expect(r.stderr).toContain("Offline mode: provider routes are restricted to loopback");
  });

  it("refuses a non-loopback route BEFORE any network I/O, with a non-zero exit", async () => {
    // TEST-NET-1 address: dialing it would hang until timeout. A fast refusal
    // therefore proves the block happened before any network I/O.
    const r = await runCli(
      ["-p", "hello", "--offline", "--approval-mode", "yolo", "--workspace", tmpDir],
      { ...baseEnv, OPENAI_BASE_URL: "https://192.0.2.1/v1" },
      10_000,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Offline mode is active");
    expect(r.stderr).toContain("192.0.2.1");
    expect(r.stderr).toContain("before any network I/O");
    // No partial stream reached stdout.
    expect(r.stdout.trim()).toBe("");
  });

  it("preflight reports the offline posture without probing (loopback allowed)", async () => {
    const r = await runCli(["--preflight", "--offline"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Offline mode: loopback endpoint allowed");
    expect(r.stdout).toContain("connectivity not probed");
    expect(server.requests.length).toBe(0);
  });

  it("preflight refuses a non-loopback route in offline mode (exit 1)", async () => {
    const r = await runCli(
      ["--preflight", "--offline"],
      { ...baseEnv, OPENAI_BASE_URL: "https://api.openai.com/v1" },
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Offline mode is active");
    expect(r.stdout).toContain("api.openai.com");
  });

  it("read-only surfaces keep working in offline mode (no provider involved)", async () => {
    const r = await runCli(["--list-sessions", "--offline"], baseEnv);
    expect(r.code).toBe(0);
  });
});
