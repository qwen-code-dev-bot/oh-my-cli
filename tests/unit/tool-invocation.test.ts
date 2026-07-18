import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOL_INVOCATION_SCHEMA,
  TOOL_INVOCATION_VERSION,
  DEFAULT_INVOKE_TIMEOUT_MS,
  MIN_INVOKE_TIMEOUT_MS,
  MAX_INVOKE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  clampInvokeTimeout,
  buildPolicyCommand,
  redactToolOutput,
  invocationExitCode,
  spawnCommandRunner,
  invokeTool,
  formatToolInvocation,
  type CommandRunner,
  type CommandRunOptions,
  type CommandRunResult,
  type ToolInvocationReport,
} from "../../src/tool-invocation.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-tool-invoke-"));
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

// A fake runner that records every invocation and returns a fixed result, so the
// gate logic can be tested deterministically without spawning real processes.
function recordingRunner(
  result: Partial<CommandRunResult> = {},
): { runner: CommandRunner; calls: CommandRunOptions[] } {
  const calls: CommandRunOptions[] = [];
  const runner: CommandRunner = async (opts) => {
    calls.push(opts);
    return {
      exitCode: 0,
      timedOut: false,
      outputCapped: false,
      stdout: "",
      stderr: "",
      elapsedMs: 1,
      ...result,
    };
  };
  return { runner, calls };
}

describe("clampInvokeTimeout", () => {
  it("returns the default for an undefined or non-finite value", () => {
    expect(clampInvokeTimeout(undefined)).toBe(DEFAULT_INVOKE_TIMEOUT_MS);
    expect(clampInvokeTimeout(Number.NaN)).toBe(DEFAULT_INVOKE_TIMEOUT_MS);
  });

  it("clamps to the bounded range", () => {
    expect(clampInvokeTimeout(1)).toBe(MIN_INVOKE_TIMEOUT_MS);
    expect(clampInvokeTimeout(10_000)).toBe(10_000);
    expect(clampInvokeTimeout(9_999_999)).toBe(MAX_INVOKE_TIMEOUT_MS);
  });
});

describe("buildPolicyCommand", () => {
  it("joins safe tokens unquoted", () => {
    expect(buildPolicyCommand("git", ["push", "origin"])).toBe("git push origin");
  });

  it("single-quotes arguments with spaces or operators so they stay one token", () => {
    expect(buildPolicyCommand("node", ["-e", "process.exit(0)"])).toBe("node -e 'process.exit(0)'");
    expect(buildPolicyCommand("echo", ["a b"])).toBe("echo 'a b'");
  });

  it("escapes embedded single quotes", () => {
    expect(buildPolicyCommand("echo", ["it's"])).toBe("echo 'it'\\''s'");
  });
});

describe("redactToolOutput", () => {
  it("redacts secret-like values", () => {
    const out = redactToolOutput("--token my-secret-value");
    expect(out).not.toContain("my-secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("collapses home and workspace path occurrences", () => {
    const home = tmpDir();
    const workspace = path.join(home, "project");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const out = redactToolOutput(`reading ${home}/x and ${workspace}/y`, workspace);
      expect(out).not.toContain(home);
      expect(out).toContain("~/x");
      expect(out).toContain("<workspace>/y");
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("invocationExitCode", () => {
  const base: ToolInvocationReport = {
    schema: TOOL_INVOCATION_SCHEMA,
    version: TOOL_INVOCATION_VERSION,
    contractVersion: 1,
    toolId: "t",
    kind: "command",
    command: "node",
    argCount: 0,
    workspace: "/w",
    gate: "passed",
    invoked: true,
    exitCode: 0,
    timedOut: false,
    outputCapped: false,
    outputCapBytes: DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: DEFAULT_INVOKE_TIMEOUT_MS,
    elapsedMs: 1,
    stdout: "",
    stderr: "",
    reason: "invoked; exit 0",
    settings: "~/.oh-my-cli/settings.json",
  };

  it("returns 0 for a successful invocation", () => {
    expect(invocationExitCode(base)).toBe(0);
  });

  it("returns 2 for any refusal gate", () => {
    for (const gate of ["not-ready", "policy-denied", "unapproved"] as const) {
      expect(invocationExitCode({ ...base, gate, invoked: false, exitCode: null })).toBe(2);
    }
  });

  it("returns 1 for runtime failures", () => {
    expect(invocationExitCode({ ...base, exitCode: 3 })).toBe(1);
    expect(invocationExitCode({ ...base, exitCode: null, timedOut: true })).toBe(1);
    expect(invocationExitCode({ ...base, exitCode: 0, outputCapped: true })).toBe(1);
    expect(invocationExitCode({ ...base, exitCode: null })).toBe(1);
  });
});

describe("spawnCommandRunner: bounded real execution", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await spawnCommandRunner({
      command: NODE_BIN,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(r.timedOut).toBe(false);
  });

  it("reports a non-zero exit code", async () => {
    const r = await spawnCommandRunner({
      command: NODE_BIN,
      args: ["-e", "process.exit(2)"],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.exitCode).toBe(2);
  });

  it("kills a hung process at the hard timeout", async () => {
    const r = await spawnCommandRunner({
      command: NODE_BIN,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 150,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  it("caps oversized output and kills the producer", async () => {
    const r = await spawnCommandRunner({
      command: NODE_BIN,
      args: ["-e", "process.stdout.write('x'.repeat(200000))"],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });
    expect(r.outputCapped).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1_000);
  });

  it("reports a spawn error for a missing command without throwing", async () => {
    const r = await spawnCommandRunner({
      command: "definitely-not-a-real-binary-xyz-123",
      args: [],
      cwd: tmpDir(),
      env: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeTruthy();
  });
});

describe("invokeTool: readiness gating", () => {
  it("invokes a resolved-ready tool (yolo) and returns a passed report", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, args: ["-e", "1"] }] },
    });
    const { runner, calls } = recordingRunner({ exitCode: 0, stdout: "hi" });
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(NODE_BIN);
  });

  it("refuses a disabled tool (isolated) without invoking", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, enabled: false }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(invocationExitCode(report)).toBe(2);
  });

  it("refuses a tool whose command is not found without invoking", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "ghost", command: "definitely-not-a-real-binary-xyz-123" }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("not-ready");
    expect(calls).toHaveLength(0);
  });
});

describe("invokeTool: command policy gate (#51)", () => {
  it("refuses a policy-denied command without invoking", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "danger", command: "git", args: ["push", "--force"] }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("policy-denied");
    expect(report.invoked).toBe(false);
    expect(report.reason).toContain("denied by policy");
    expect(calls).toHaveLength(0);
    expect(invocationExitCode(report)).toBe(2);
  });
});

describe("invokeTool: approval gate", () => {
  it("refuses an unapproved tool under the default mode (non-interactive)", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, args: ["-e", "1"] }] },
    });
    const { runner, calls } = recordingRunner();
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "default",
      runner,
    });
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(invocationExitCode(report)).toBe(2);
  });
});

describe("invokeTool: runtime failures and redaction", () => {
  it("maps a non-zero exit to a runtime failure", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const { runner } = recordingRunner({ exitCode: 3 });
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.gate).toBe("passed");
    expect(report.exitCode).toBe(3);
    expect(report.reason).toContain("code 3");
    expect(invocationExitCode(report)).toBe(1);
  });

  it("maps a timeout to a runtime failure", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const { runner } = recordingRunner({ exitCode: null, timedOut: true });
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      timeoutMs: 100,
      runner,
    });
    expect(report.timedOut).toBe(true);
    expect(report.reason).toContain("timeout");
    expect(invocationExitCode(report)).toBe(1);
  });

  it("redacts secrets in captured output", async () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const { runner } = recordingRunner({ exitCode: 0, stdout: "--token my-secret-value" });
    const report = await invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner,
    });
    expect(report.stdout).not.toContain("my-secret-value");
    expect(report.stdout).toContain("[REDACTED]");
    const json = JSON.stringify(report);
    expect(json).not.toContain("my-secret-value");
  });

  it("throws (caller maps to exit 2) when there is no tools section", async () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    await expect(
      invokeTool({ settingsPath: settings, workspace: tmpDir(), approvalMode: "yolo" }),
    ).rejects.toThrow(/no settings.tools section/);
  });
});

describe("formatToolInvocation", () => {
  it("renders the gate, command, and reason without leaking argument values", () => {
    const settings = writeSettings({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, args: ["--token", "should-not-appear"] }] },
    });
    return invokeTool({
      settingsPath: settings,
      workspace: tmpDir(),
      approvalMode: "yolo",
      runner: recordingRunner({ exitCode: 0, stdout: "ok" }).runner,
    }).then((report) => {
      const out = formatToolInvocation(report);
      expect(out).toContain("Tool:");
      expect(out).toContain("echo");
      expect(out).toContain(TOOL_INVOCATION_SCHEMA);
      expect(out).toContain("Gate:");
      expect(out).not.toContain("should-not-appear");
    });
  });
});
