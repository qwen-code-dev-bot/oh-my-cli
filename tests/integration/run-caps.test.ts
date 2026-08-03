import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createFakeServer, type FakeServer } from "../fake-provider.js";

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

// Extract the terminal `complete` record from a headless JSON stream.
function completeEvent(stdout: string): { ok: boolean; exitCode: number; rounds: number; reason: string } | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "complete") {
        return parsed as unknown as { ok: boolean; exitCode: number; rounds: number; reason: string };
      }
    } catch {
      /* non-JSON line */
    }
  }
  return null;
}

describe("Integration: --max-turns and --max-wall-time bound headless runs (#515)", () => {
  let server: FakeServer;
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-runcaps-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-runcaps-ws-"));
    fs.writeFileSync(path.join(wsDir, "x.txt"), "fixture\n");
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
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it("--max-turns 1 stops a tool-looping run after one round with a scriptable reason", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [{ id: "c1", name: "read", arguments: JSON.stringify({ path: "x.txt" }) }],
    });
    const r = await runCli(
      ["-p", "keep reading", "--output", "json", "--max-turns", "1", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    const complete = completeEvent(r.stdout);
    expect(complete).not.toBeNull();
    expect(complete!.ok).toBe(false);
    expect(complete!.reason).toBe("max_turns_reached");
    expect(complete!.rounds).toBe(1);
    // Exactly one provider round happened before the boundary stop.
    expect(server.requests.length).toBe(1);
  });

  it("honors the OMC_MAX_TURNS environment fallback", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [{ id: "c1", name: "read", arguments: JSON.stringify({ path: "x.txt" }) }],
    });
    const requestCountBefore = server.requests.length;
    const r = await runCli(
      ["-p", "keep reading", "--output", "json", "--workspace", wsDir],
      { ...baseEnv, OMC_MAX_TURNS: "1" },
    );
    expect(r.code).toBe(1);
    const complete = completeEvent(r.stdout);
    expect(complete!.reason).toBe("max_turns_reached");
    expect(server.requests.length).toBe(requestCountBefore + 1);
  });

  it("an invalid --max-wall-time value is a usage error before any provider call", async () => {
    const requestCountBefore = server.requests.length;
    const r = await runCli(
      ["-p", "hello", "--output", "json", "--max-wall-time", "soon", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid wall-time budget");
    expect(server.requests.length).toBe(requestCountBefore);
  });

  it("--max-tool-calls 1 stops a tool-looping run at the first boundary after one call", async () => {
    server.setResponse({
      type: "tool_calls",
      toolCalls: [{ id: "c1", name: "read", arguments: JSON.stringify({ path: "x.txt" }) }],
    });
    const requestCountBefore = server.requests.length;
    const r = await runCli(
      ["-p", "keep reading", "--output", "json", "--max-tool-calls", "1", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    const complete = completeEvent(r.stdout);
    expect(complete).not.toBeNull();
    expect(complete!.ok).toBe(false);
    expect(complete!.reason).toBe("tool_call_budget_reached");
    // Exactly one provider round happened: its tool call ran, then the
    // boundary stopped the run.
    expect(server.requests.length).toBe(requestCountBefore + 1);
  });

  it("an invalid --max-tool-calls value is a usage error before any provider call", async () => {
    const requestCountBefore = server.requests.length;
    const r = await runCli(
      ["-p", "hello", "--output", "json", "--max-tool-calls", "many", "--workspace", wsDir],
      baseEnv,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid max tool calls");
    expect(server.requests.length).toBe(requestCountBefore);
  });
});
