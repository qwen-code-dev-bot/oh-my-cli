import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// A command guaranteed to resolve and run on this host: the running Node binary.
const NODE_BIN = process.execPath;
// The local stdio MCP server fixture (one file, behavior selected by --mode).
const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");

function serverEntry(mode: string, extra: Record<string, unknown> = {}): unknown {
  return { id: "s", command: NODE_BIN, args: [FIXTURE, "--mode", mode], ...extra };
}

describe("Integration: MCP server extension invocation", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-mcp-invoke-int-"));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function workspace(): string {
    return fs.mkdtempSync(path.join(tmpRoot, "ws-"));
  }

  it("connects to a resolved-ready server (yolo) and calls its tool with exit 0", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", "hello=world", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.mcp-invocation");
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.outcome).toBe("called");
    expect(report.toolName).toBe("echo");
    expect(report.content).toContain("world");
  });

  it("selects an explicitly named tool from a multi-tool server", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("multi")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-tool", "alpha", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("called");
    expect(report.toolName).toBe("alpha");
    expect(report.availableToolCount).toBe(2);
  });

  it("fails closed (exit 1) on tool-selection ambiguity", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("multi")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("passed");
    expect(report.outcome).toBe("ambiguous");
  });

  it("does not connect to a policy-denied server command and exits 2", async () => {
    const home = homeWith({
      mcp: { contractVersion: 1, entries: [{ id: "danger", command: "git", args: ["push", "--force"] }] },
    });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("policy-denied");
    expect(report.invoked).toBe(false);
    expect(report.reason).toContain("denied by policy");
  });

  it("refuses an unapproved server under the default mode and exits 2", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
  });

  it("refuses a non-ready (disabled) server and exits 2", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo", { enabled: false })] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
  });

  it("enforces the hard timeout against a hanging server and exits 1", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("hang")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--invoke-timeout", "300", "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.timedOut).toBe(true);
    expect(report.outcome).toBe("timeout");
  });

  it("maps a tool-level error to a runtime failure (exit 1)", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("toolerror")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("tool-error");
    expect(report.isError).toBe(true);
  });

  it("fails closed when the server exposes no tools (exit 1)", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("notools")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outcome).toBe("no-tools");
  });

  it("redacts secrets in the captured tool result", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(combined).toContain("[REDACTED]");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Server:");
    expect(r.stdout).toContain("Gate:");
    expect(r.stdout).toContain("oh-my-cli.mcp-invocation");
  });

  it("exits 2 when the settings file has no mcp section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.mcp section");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "yaml"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("exits 2 on an invalid approval mode", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "rubber-stamp", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid approval mode");
  });

  it("exits 2 on a malformed --mcp-arg (no key=value)", async () => {
    const home = homeWith({ mcp: { contractVersion: 1, entries: [serverEntry("echo")] } });
    const r = await runCli(
      ["--invoke-mcp", "--approval-mode", "yolo", "--mcp-arg", "novalue", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid --mcp-arg");
  });
});
