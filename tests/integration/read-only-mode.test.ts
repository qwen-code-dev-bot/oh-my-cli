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
  timeoutMs = 20_000,
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

// The tool result the agent fed back on the follow-up request.
function toolResultContent(requests: Array<{ body: unknown }>, reqIndex: number): string {
  const body = requests[reqIndex]?.body as { messages?: Array<{ role: string; content: unknown }> };
  const toolMsgs = (body?.messages ?? []).filter((m) => m.role === "tool");
  return String(toolMsgs[toolMsgs.length - 1]?.content ?? "");
}

describe("Integration: read-only mode (--read-only)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-readonly-int-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-readonly-int-home-"));
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "hello\n");
    env = {
      HOME: homeDir,
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("refuses a mutating write fail-closed in read-only mode (even under yolo)", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "write", arguments: JSON.stringify({ path: "new.txt", content: "hi" }) }] },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--read-only", "--approval-mode", "yolo", "--workspace", tmpDir],
      env,
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/read-only mode allows only read-only tools/);
    // The write did not happen.
    expect(fs.existsSync(path.join(tmpDir, "new.txt"))).toBe(false);
  });

  it("allows a read-only tool in read-only mode", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "read", arguments: JSON.stringify({ path: "existing.txt" }) }] },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "investigate", "--read-only", "--approval-mode", "yolo", "--workspace", tmpDir],
      env,
    );
    expect(r.code).toBe(0);
    // The read succeeded and returned the file content.
    expect(toolResultContent(server.requests, 1)).toContain("hello");
  });

  it("allows a mutating write when read-only mode is off (control)", async () => {
    server.setResponses([
      { type: "tool_calls", toolCalls: [{ id: "c1", name: "write", arguments: JSON.stringify({ path: "control.txt", content: "hi" }) }] },
      { type: "text", content: "done" },
    ]);
    const r = await runCli(
      ["-p", "do work", "--approval-mode", "yolo", "--workspace", tmpDir],
      env,
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(tmpDir, "control.txt"))).toBe(true);
  });
});
