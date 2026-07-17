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

// The tool result the agent fed back on the follow-up request (proves the tool
// actually executed — or was denied — against the workspace).
function toolResultContent(
  requests: Array<{ body: unknown }>,
  reqIndex: number,
): string {
  const body = requests[reqIndex]?.body as {
    messages?: Array<{ role: string; content: unknown }>;
  };
  const toolMsgs = (body?.messages ?? []).filter((m) => m.role === "tool");
  return String(toolMsgs[toolMsgs.length - 1]?.content ?? "");
}

function writeCall(fileName: string) {
  return {
    type: "tool_calls" as const,
    toolCalls: [
      {
        id: "call_1",
        name: "write",
        arguments: JSON.stringify({ path: fileName, content: "hi" }),
      },
    ],
  };
}

describe("Integration: folder-trust enforcement", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-trust-"));
    // A fresh HOME so the user trust store starts empty (workspace untrusted).
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-trust-sess-"));
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

  it("permits mutation for a trusted workspace", async () => {
    server.setResponses([writeCall("trusted.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--enforce-folder-trust", "--trust", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(tmpDir, "trusted.txt"))).toBe(true);
  });

  it("fails closed for an untrusted workspace", async () => {
    server.setResponses([writeCall("untrusted.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--enforce-folder-trust", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/fail closed/i);
    expect(fs.existsSync(path.join(tmpDir, "untrusted.txt"))).toBe(false);
  });

  it("yolo cannot widen an untrusted workspace (non-escalation)", async () => {
    server.setResponses([writeCall("yolo.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "yolo", "--enforce-folder-trust", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/fail closed/i);
    expect(fs.existsSync(path.join(tmpDir, "yolo.txt"))).toBe(false);
  });

  it("an enforced sandbox permits mutation even when untrusted", async () => {
    server.setResponses([writeCall("sandboxed.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--enforce-folder-trust", "--workspace", tmpDir],
      { ...baseEnv, OMC_SANDBOX: "enforced" },
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(tmpDir, "sandboxed.txt"))).toBe(true);
  });

  it("reports sandbox-unavailable and fails closed when a sandbox is required", async () => {
    server.setResponses([writeCall("reqsandbox.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--enforce-folder-trust", "--workspace", tmpDir],
      { ...baseEnv, OMC_REQUIRE_SANDBOX: "1" },
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/fail closed/i);
    expect(result.stderr).toContain("sandbox-unavailable");
    expect(fs.existsSync(path.join(tmpDir, "reqsandbox.txt"))).toBe(false);
  });

  it("does not enforce when the flag is off (default behaviour preserved)", async () => {
    server.setResponses([writeCall("noenforce.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(tmpDir, "noenforce.txt"))).toBe(true);
  });

  it("rejects a path-escape write even in a trusted workspace", async () => {
    server.setResponses([writeCall("../../escape.txt"), { type: "text", content: "done" }]);
    const result = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--enforce-folder-trust", "--trust", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/escape/i);
  });

  it("--trust-info prints the decision and exits 0", async () => {
    const result = await runCli(
      ["--trust-info", "--enforce-folder-trust", "--workspace", tmpDir],
      baseEnv,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Trust state: untrusted");
    expect(result.stdout).toContain("DENIED (fail closed)");
  });
});
