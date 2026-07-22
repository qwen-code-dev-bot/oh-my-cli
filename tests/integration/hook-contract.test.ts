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

// The tool result the agent fed back on the follow-up request (proves the tool
// actually executed — or was denied by a hook — against the workspace).
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

// A hook command (no-shell spawn) that exits with a given code. `node` is always
// on PATH (the CLI itself runs under node), so this is portable.
function nodeExit(code: number): { command: string; args: string[] } {
  return { command: "node", args: ["-e", `process.exit(${code})`] };
}

// A hook command that prints a JSON permission decision on stdout then exits 0.
function nodeDecision(decision: { permissionDecision: string; reason?: string }): {
  command: string;
  args: string[];
} {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(decision))})`;
  return { command: "node", args: ["-e", script] };
}

describe("Integration: PreToolUse hook contract", () => {
  let server: FakeServer;
  let tmpRoot: string;
  let cleanEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-hook-int-"));
    // Blank the OPENAI_* variables so the host environment cannot leak into a run.
    cleanEnv = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function runEnv(home: string): Record<string, string> {
    return {
      ...cleanEnv,
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: home,
    };
  }

  function hooksSection(...preToolUse: unknown[]): unknown {
    return { hooks: { contractVersion: 1, PreToolUse: preToolUse } };
  }

  const validHooks = hooksSection({ matcher: "*", command: "/usr/bin/guard", args: ["--strict"] });

  // --- Listing / contract validation (no provider needed) ---

  it("lists declared hooks as redacted JSON and exits 0", async () => {
    const home = homeWith(validHooks);
    const r = await runCli(["--list-hooks", "--output", "json"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.hook-contract");
    expect(report.contractVersion).toBe(1);
    expect(report.hooks).toHaveLength(1);
    expect(report.hooks[0].event).toBe("PreToolUse");
    expect(report.hooks[0].matcher).toBe("*");
    expect(report.hooks[0].args).toBe(1);
  });

  it("emits a human-readable list by default", async () => {
    const home = homeWith(validHooks);
    const r = await runCli(["--list-hooks"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PreToolUse: 1");
    expect(r.stdout).toContain("*");
    expect(r.stdout).toContain("/usr/bin/guard");
  });

  it("reports an empty inventory and exits 0 when there is no hooks section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--list-hooks", "--output", "json"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.hooks).toEqual([]);
  });

  it("exits 2 (fail closed) on an unsupported contract version", async () => {
    const home = homeWith({ hooks: { contractVersion: 99, PreToolUse: [] } });
    const r = await runCli(["--list-hooks"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 on a raw credential field in a hook entry", async () => {
    const home = homeWith(hooksSection({ matcher: "*", command: "g", token: "leaked" }));
    const r = await runCli(["--list-hooks"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("raw credential field");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith(validHooks);
    const r = await runCli(["--list-hooks", "--output", "yaml"], { ...cleanEnv, HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("does not honor a project-scope hook (user scope only)", async () => {
    // User scope has no hooks; the workspace's project file declares one.
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    fs.mkdirSync(path.join(ws, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".oh-my-cli", "settings.json"),
      JSON.stringify(hooksSection({ matcher: "*", command: "evil" })),
    );
    const r = await runCli(["--list-hooks", "--output", "json", "--workspace", ws], {
      ...cleanEnv,
      HOME: home,
    });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.hooks).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain("evil");
  });

  // --- Deny gate end-to-end via the headless -p path ---

  it("a deny hook (exit 2) blocks a matching tool call; the side effect never happens", async () => {
    server.setResponses([writeCall("denied.txt"), { type: "text", content: "done" }]);
    const home = homeWith(hooksSection({ matcher: "*", ...nodeExit(2) }));
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/denied by a user PreToolUse hook/i);
    expect(fs.existsSync(path.join(ws, "denied.txt"))).toBe(false);
  });

  it("a deny hook is a hard floor even in yolo mode", async () => {
    server.setResponses([writeCall("yolo.txt"), { type: "text", content: "done" }]);
    const home = homeWith(hooksSection({ matcher: "write", ...nodeExit(2) }));
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "yolo", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toMatch(/denied by a user PreToolUse hook/i);
    expect(fs.existsSync(path.join(ws, "yolo.txt"))).toBe(false);
  });

  it("a non-matching hook does not block the tool call", async () => {
    server.setResponses([writeCall("allowed.txt"), { type: "text", content: "done" }]);
    const home = homeWith(hooksSection({ matcher: "shell", ...nodeExit(2) }));
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(ws, "allowed.txt"))).toBe(true);
  });

  it("an allow / exit-0 hook does not block (a hook can never relax)", async () => {
    server.setResponses([writeCall("ok.txt"), { type: "text", content: "done" }]);
    const home = homeWith(hooksSection({ matcher: "*", ...nodeExit(0) }));
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(ws, "ok.txt"))).toBe(true);
  });

  it("a JSON deny decision blocks and surfaces the reason", async () => {
    server.setResponses([writeCall("policy.txt"), { type: "text", content: "done" }]);
    const home = homeWith(
      hooksSection({ matcher: "*", ...nodeDecision({ permissionDecision: "deny", reason: "blocked by org policy" }) }),
    );
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    const tool = toolResultContent(server.requests, 1);
    expect(tool).toMatch(/denied by a user PreToolUse hook/i);
    expect(tool).toContain("blocked by org policy");
    expect(fs.existsSync(path.join(ws, "policy.txt"))).toBe(false);
  });

  it("redacts secrets and the home path in the surfaced deny reason", async () => {
    server.setResponses([writeCall("leak.txt"), { type: "text", content: "done" }]);
    // Low-entropy fake token: matches the redactor's `sk-<16+ alnum>` pattern but
    // stays under gitleaks' entropy threshold so CI's secret scan does not flag it.
    const decoy = "sk-aaaaaaaaaaaaaaaaaaaa";
    const home = homeWith(
      hooksSection({
        matcher: "*",
        ...nodeDecision({ permissionDecision: "deny", reason: `leak ${decoy} at HOME` }),
      }),
    );
    // The hook injects the real HOME path into its reason at runtime; the CLI must
    // collapse it to ~ before the reason is ever surfaced.
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    const tool = toolResultContent(server.requests, 1);
    expect(tool).toContain("[REDACTED]");
    expect(tool).not.toContain(decoy);
    expect(fs.existsSync(path.join(ws, "leak.txt"))).toBe(false);
  });

  it("fails closed (exit 2) on a malformed hooks section before any provider call", async () => {
    const home = homeWith({ hooks: { contractVersion: 99, PreToolUse: [] } });
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
    expect(server.requests.length).toBe(0);
  });

  it("a project-scope deny hook is never honored at runtime; the write succeeds", async () => {
    server.setResponses([writeCall("safe.txt"), { type: "text", content: "done" }]);
    // User scope has no hooks; the (untrusted) workspace declares a deny hook.
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    fs.mkdirSync(path.join(ws, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".oh-my-cli", "settings.json"),
      JSON.stringify(hooksSection({ matcher: "*", ...nodeExit(2) })),
    );
    const r = await runCli(
      ["-p", "write", "--approval-mode", "auto-edit", "--workspace", ws],
      runEnv(home),
    );
    expect(r.code).toBe(0);
    expect(toolResultContent(server.requests, 1)).toContain("Wrote");
    expect(fs.existsSync(path.join(ws, "safe.txt"))).toBe(true);
  });
});
