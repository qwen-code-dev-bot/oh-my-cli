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

describe("Integration: tool extension invocation", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-tool-invoke-int-"));
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

  it("invokes a resolved-ready tool (yolo) and returns a redacted result with exit 0", async () => {
    const home = homeWith({
      tools: {
        contractVersion: 1,
        entries: [{ id: "echo", command: NODE_BIN, args: ["-e", "process.stdout.write('hello from tool')"] }],
      },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.tool-invocation");
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("hello from tool");
  });

  it("does not execute a policy-denied command and exits 2", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "danger", command: "git", args: ["push", "--force"] }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("policy-denied");
    expect(report.invoked).toBe(false);
    expect(report.reason).toContain("denied by policy");
  });

  it("refuses an unapproved tool under the default mode and exits 2", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("unapproved");
    expect(report.invoked).toBe(false);
  });

  it("refuses a non-ready (disabled) tool and exits 2", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, enabled: false }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("not-ready");
    expect(report.invoked).toBe(false);
  });

  it("enforces the hard timeout and exits 1 with a safe result", async () => {
    const home = homeWith({
      tools: {
        contractVersion: 1,
        entries: [{ id: "hang", command: NODE_BIN, args: ["-e", "setTimeout(() => {}, 60000)"] }],
      },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--invoke-timeout", "250", "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.gate).toBe("passed");
    expect(report.invoked).toBe(true);
    expect(report.timedOut).toBe(true);
    expect(report.exitCode).toBeNull();
  });

  it("maps a non-zero tool exit to a runtime failure (exit 1)", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "fail", command: NODE_BIN, args: ["-e", "process.exit(3)"] }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.exitCode).toBe(3);
    expect(report.gate).toBe("passed");
  });

  it("caps oversized output and exits 1", async () => {
    const home = homeWith({
      tools: {
        contractVersion: 1,
        entries: [{ id: "flood", command: NODE_BIN, args: ["-e", "process.stdout.write('x'.repeat(500000))"] }],
      },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.outputCapped).toBe(true);
  });

  it("redacts secrets in the captured output", async () => {
    const home = homeWith({
      tools: {
        contractVersion: 1,
        entries: [{ id: "leak", command: NODE_BIN, args: ["-e", "process.stdout.write('--token my-secret-value')"] }],
      },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "json"],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("my-secret-value");
    expect(combined).toContain("[REDACTED]");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN, args: ["-e", "1"] }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Tool:");
    expect(r.stdout).toContain("Gate:");
    expect(r.stdout).toContain("oh-my-cli.tool-invocation");
  });

  it("exits 2 when the settings file has no tools section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.tools section");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "yolo", "--workspace", workspace(), "--output", "yaml"],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("exits 2 on an invalid approval mode", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "echo", command: NODE_BIN }] },
    });
    const r = await runCli(
      ["--invoke-tool", "--approval-mode", "rubber-stamp", "--workspace", workspace()],
      { HOME: home },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid approval mode");
  });
});
