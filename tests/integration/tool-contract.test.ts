import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// A command guaranteed to resolve on this host: the running Node binary.
const NODE_BIN = process.execPath;

describe("Integration: tool extension contract", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-tool-contract-int-"));
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

  const validTools = {
    tools: {
      contractVersion: 1,
      default: "fs",
      entries: [
        {
          id: "fs",
          kind: "command",
          command: NODE_BIN,
          args: ["server.js", "--token", "should-not-appear"],
          capabilities: { readOnly: true },
        },
      ],
    },
  };

  it("resolves the default tool to a ready state as redacted JSON and exits 0", async () => {
    const home = homeWith(validTools);
    const r = await runCli(["--tool-contract", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.tool-contract");
    expect(report.toolId).toBe("fs");
    expect(report.kind).toBe("command");
    expect(report.state).toBe("ready");
    expect(report.argCount).toBe(3);
    // Redaction: argument values never appear in output.
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("should-not-appear");
  });

  it("selects a specific tool via --tool", async () => {
    const home = homeWith({
      tools: {
        contractVersion: 1,
        entries: [
          { id: "one", command: NODE_BIN },
          { id: "two", command: NODE_BIN },
        ],
      },
    });
    const r = await runCli(["--tool-contract", "--tool", "two", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).toolId).toBe("two");
  });

  it("reports declared without probing via --no-probe", async () => {
    const home = homeWith(validTools);
    const r = await runCli(["--tool-contract", "--no-probe", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe("declared");
    expect(report.probeMs).toBeNull();
  });

  it("isolates a disabled tool and still exits 0 (safe failure default)", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "fs", command: NODE_BIN, enabled: false }] },
    });
    const r = await runCli(["--tool-contract", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe("isolated");
    expect(report.reason).toBe("disabled");
  });

  it("isolates a tool whose command is not found and still exits 0", async () => {
    const home = homeWith({
      tools: { contractVersion: 1, entries: [{ id: "ghost", command: "definitely-not-a-real-binary-xyz-123" }] },
    });
    const r = await runCli(["--tool-contract", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.state).toBe("isolated");
    expect(report.reason).toBe("command not found");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith(validTools);
    const r = await runCli(["--tool-contract"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Tool:");
    expect(r.stdout).toContain("command");
    expect(r.stdout).not.toContain("should-not-appear");
  });

  it("honors an explicit --settings path", async () => {
    const custom = path.join(tmpRoot, "explicit.json");
    fs.writeFileSync(custom, JSON.stringify(validTools));
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const r = await runCli(["--tool-contract", "--settings", custom, "--output", "json"], {
      HOME: emptyHome,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).toolId).toBe("fs");
  });

  it("exits 2 when the settings file has no tools section", async () => {
    const home = homeWith({ model: { name: "m", apiKeyEnv: "K" } });
    const r = await runCli(["--tool-contract"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no settings.tools section");
  });

  it("exits 2 (fail closed) on an unsupported contract version", async () => {
    const home = homeWith({ tools: { contractVersion: 99, entries: [{ id: "a", command: "node" }] } });
    const r = await runCli(["--tool-contract"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  it("exits 2 on an unknown tool id", async () => {
    const home = homeWith(validTools);
    const r = await runCli(["--tool-contract", "--tool", "ghost"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ghost");
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith(validTools);
    const r = await runCli(["--tool-contract", "--output", "yaml"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });
});
