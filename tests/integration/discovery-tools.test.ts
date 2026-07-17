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
// actually executed against the workspace, not just that a call was streamed).
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

describe("Integration: read-only discovery tools", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-disc-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-disc-sess-"));
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

  // `default` approval mode denies shell without a TTY; read-category discovery
  // tools must run anyway — that is the whole point of the feature.
  it("list runs without approval in default mode and returns entries", async () => {
    fs.writeFileSync(path.join(tmpDir, "alpha.txt"), "x");
    fs.mkdirSync(path.join(tmpDir, "beta"), { recursive: true });

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "list", arguments: JSON.stringify({}) }],
      },
      { type: "text", content: "Listed the workspace" },
    ]);

    const result = await runCli(
      ["-p", "List the workspace", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    const toolOut = toolResultContent(server.requests, 1);
    expect(toolOut).toContain("alpha.txt");
    expect(toolOut).toContain("beta");
  });

  it("glob discovers files recursively end-to-end", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "deep", "thing.ts"), "x");

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) }],
      },
      { type: "text", content: "Found the file" },
    ]);

    const result = await runCli(
      ["-p", "Find ts files", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("src/deep/thing.ts");
  });

  it("grep returns path:line matches end-to-end", async () => {
    fs.writeFileSync(path.join(tmpDir, "notes.md"), "first line\nNEEDLE here\nlast line");

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "grep", arguments: JSON.stringify({ pattern: "NEEDLE" }) }],
      },
      { type: "text", content: "Found the needle" },
    ]);

    const result = await runCli(
      ["-p", "Search for NEEDLE", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("notes.md:2: NEEDLE here");
  });

  it("glob honors ignore rules (node_modules excluded)", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg", "dep.ts"), "x");
    fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "app", "main.ts"), "x");

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) }],
      },
      { type: "text", content: "done" },
    ]);

    await runCli(
      ["-p", "Find ts files", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    const toolOut = toolResultContent(server.requests, 1);
    expect(toolOut).toContain("app/main.ts");
    expect(toolOut).not.toContain("node_modules");
  });

  it("grep skips binary files with explicit metadata", async () => {
    fs.writeFileSync(path.join(tmpDir, "data.bin"), Buffer.from("NEEDLE\u0000\u0001\u0002binary"));
    fs.writeFileSync(path.join(tmpDir, "data.txt"), "NEEDLE text");

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "grep", arguments: JSON.stringify({ pattern: "NEEDLE" }) }],
      },
      { type: "text", content: "done" },
    ]);

    await runCli(
      ["-p", "Search for NEEDLE", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    const toolOut = toolResultContent(server.requests, 1);
    expect(toolOut).toContain("data.txt:1: NEEDLE text");
    expect(toolOut).toContain("binary skipped");
  });

  it("grep reports truncation when results exceed bounds", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "huge.txt"),
      Array.from({ length: 1001 }, () => "NEEDLE").join("\n"),
    );

    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "grep", arguments: JSON.stringify({ pattern: "NEEDLE" }) }],
      },
      { type: "text", content: "done" },
    ]);

    await runCli(
      ["-p", "Search for NEEDLE", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(toolResultContent(server.requests, 1)).toContain("truncated");
  });

  it("list rejects path traversal escape safely", async () => {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "list", arguments: JSON.stringify({ path: "../../etc" }) }],
      },
      { type: "text", content: "done" },
    ]);

    const result = await runCli(
      ["-p", "List outside", "--approval-mode", "default", "--workspace", tmpDir],
      baseEnv,
    );

    expect(result.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/escape/i);
  });
});
