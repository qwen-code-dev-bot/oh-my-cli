import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../../src/tool-invocation.js";
import {
  MCP_INVOCATION_SCHEMA,
  MCP_INVOCATION_VERSION,
  mcpInvocationExitCode,
  stdioMcpRunner,
  invokeMcpServer,
  formatMcpInvocation,
  type McpRunner,
  type McpRunOptions,
  type McpRunResult,
  type McpInvocationReport,
} from "../../src/mcp-invocation.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-mcp-invoke-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// A command guaranteed to resolve and run: the running Node binary.
const NODE_BIN = process.execPath;
// The local stdio MCP server fixture (one file, behavior selected by --mode).
const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");

function fixtureArgs(mode: string): string[] {
  return [FIXTURE, "--mode", mode];
}

// A fake runner that records every invocation and returns a fixed result, so the
// gate logic can be tested deterministically without a live server.
function recordingRunner(
  result: Partial<McpRunResult> = {},
): { runner: McpRunner; calls: McpRunOptions[] } {
  const calls: McpRunOptions[] = [];
  const runner: McpRunner = async (opts) => {
    calls.push(opts);
    return {
      outcome: "called",
      toolName: "echo",
      availableTools: ["echo"],
      exitCode: null,
      timedOut: false,
      outputCapped: false,
      content: "",
      isError: false,
      elapsedMs: 1,
      reason: "tool call succeeded",
      ...result,
    };
  };
  return { runner, calls };
}

describe("mcpInvocationExitCode", () => {
  const base: McpInvocationReport = {
    schema: MCP_INVOCATION_SCHEMA,
    version: MCP_INVOCATION_VERSION,
    contractVersion: 1,
    serverId: "s",
    transport: "stdio",
    command: "node",
    argCount: 0,
    workspace: "/w",
    gate: "passed",
    invoked: true,
    toolName: "echo",
    availableToolCount: 1,
    outcome: "called",
    exitCode: null,
    timedOut: false,
    outputCapped: false,
    outputCapBytes: DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: 30_000,
    elapsedMs: 1,
    content: "",
    isError: false,
    reason: "tool call succeeded",
    settings: "~/.oh-my-cli/settings.json",
  };

  it("returns 0 for a successful tool call", () => {
    expect(mcpInvocationExitCode(base)).toBe(0);
  });

  it("returns 2 for any refusal gate", () => {
    for (const gate of ["not-ready", "policy-denied", "unapproved"] as const) {
      expect(mcpInvocationExitCode({ ...base, gate, invoked: false, outcome: gate })).toBe(2);
    }
  });

  it("returns 1 for runtime failures after connecting", () => {
    expect(mcpInvocationExitCode({ ...base, outcome: "no-tools", toolName: null })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outcome: "tool-not-found", toolName: null })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outcome: "ambiguous", toolName: null })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outcome: "handshake-failed", toolName: null })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outcome: "spawn-error", toolName: null })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outcome: "tool-error", isError: true })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, timedOut: true })).toBe(1);
    expect(mcpInvocationExitCode({ ...base, outputCapped: true })).toBe(1);
  });

  it("returns 1 when a tool call reports a tool-level error", () => {
    expect(mcpInvocationExitCode({ ...base, outcome: "called", isError: true })).toBe(1);
  });
});

describe("stdioMcpRunner: bounded real session", () => {
  it("handshakes, lists, and calls the sole tool (echo)", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("echo"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: { hello: "world" },
    });
    expect(r.outcome).toBe("called");
    expect(r.toolName).toBe("echo");
    expect(r.availableTools).toEqual(["echo"]);
    expect(r.content).toContain("world");
    expect(r.isError).toBe(false);
  });

  it("selects an explicitly named tool from a multi-tool server", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("multi"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolName: "alpha",
      toolArguments: {},
    });
    expect(r.outcome).toBe("called");
    expect(r.toolName).toBe("alpha");
    expect(r.availableTools).toEqual(["alpha", "beta"]);
  });

  it("fails closed on ambiguity when no tool is named and several exist", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("multi"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.outcome).toBe("ambiguous");
    expect(r.toolName).toBeNull();
  });

  it("fails closed when the named tool is not exposed", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("multi"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolName: "ghost",
      toolArguments: {},
    });
    expect(r.outcome).toBe("tool-not-found");
  });

  it("reports a server that exposes no tools", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("notools"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.outcome).toBe("no-tools");
  });

  it("reports a tool-level error via isError", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("toolerror"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.outcome).toBe("tool-error");
    expect(r.isError).toBe(true);
  });

  it("fails closed when the initialize handshake returns no result", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("badhandshake"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.outcome).toBe("handshake-failed");
  });

  it("kills a hanging server at the hard timeout", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("hang"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 200,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.timedOut).toBe(true);
    expect(r.outcome).toBe("timeout");
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  it("caps oversized output and kills the producer", async () => {
    const r = await stdioMcpRunner({
      command: NODE_BIN,
      args: fixtureArgs("flood"),
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
      toolArguments: {},
    });
    expect(r.outputCapped).toBe(true);
    expect(r.outcome).toBe("output-capped");
  });

  it("reports a spawn error for a missing command without throwing", async () => {
    const r = await stdioMcpRunner({
      command: "definitely-not-a-real-binary-xyz-123",
      args: [],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      toolArguments: {},
    });
    expect(r.outcome).toBe("spawn-error");
    expect(r.exitCode).toBeNull();
  });
});

describe("invokeMcpServer: readiness gating", () => {
  it("connects to a resolved-ready server (yolo) and returns a passed report", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "s", command: NODE_BIN, args: fixtureArgs("echo") }] },
    });
    const { runner, calls } = recordingRunner({ outcome: "called", content: "hi" });
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(NODE_BIN);
    expect(mcpInvocationExitCode(report)).toBe(0);
  });

  it("refuses a disabled server (isolated) without connecting", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "s", command: NODE_BIN, enabled: false }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mcpInvocationExitCode(report)).toBe(2);
  });

  it("refuses a server whose command is not found without connecting", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "ghost", command: "definitely-not-a-real-binary-xyz-123" }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("not-ready");
    expect(calls).toHaveLength(0);
  });
});

describe("invokeMcpServer: command policy gate (#51)", () => {
  it("refuses a policy-denied server command without connecting", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "danger", command: "git", args: ["push", "--force"] }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("policy-denied");
    expect(report.invoked).toBe(false);
    expect(report.reason).toContain("denied by policy");
    expect(calls).toHaveLength(0);
    expect(mcpInvocationExitCode(report)).toBe(2);
  });
});

describe("invokeMcpServer: approval gate", () => {
  it("refuses an unapproved server under the default mode (non-interactive)", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "s", command: NODE_BIN, args: fixtureArgs("echo") }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "default",
      runner,
    });
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mcpInvocationExitCode(report)).toBe(2);
  });
});

describe("invokeMcpServer: redaction and contract errors", () => {
  it("redacts secrets in the captured tool result", async () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "s", command: NODE_BIN, args: fixtureArgs("echo") }] },
    });
    const { runner } = recordingRunner({ outcome: "called", content: "--token my-secret-value" });
    const report = await invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.content).not.toContain("my-secret-value");
    expect(report.content).toContain("[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("my-secret-value");
  });

  it("throws (caller maps to exit 2) when there is no mcp section", async () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    await expect(
      invokeMcpServer({ settingsPath: settings, workspace: tmpDir(), approvalMode: "yolo" }),
    ).rejects.toThrow(/no settings.mcp section/);
  });
});

describe("formatMcpInvocation", () => {
  it("renders the gate, server, and reason without leaking argument values", () => {
    const settings = writeSettings({
      mcp: { contractVersion: 1, entries: [{ id: "s", command: NODE_BIN, args: fixtureArgs("echo") }] },
    });
    return invokeMcpServer({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      toolArguments: { token: "should-not-appear" },
      runner: recordingRunner({ outcome: "called", content: "ok" }).runner,
    }).then((report) => {
      const out = formatMcpInvocation(report);
      expect(out).toContain("Server:");
      expect(out).toContain("s");
      expect(out).toContain(MCP_INVOCATION_SCHEMA);
      expect(out).toContain("Gate:");
      expect(out).not.toContain("should-not-appear");
    });
  });
});
