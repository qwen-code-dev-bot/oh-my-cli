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

const MCP_READY = {
  mcp: {
    contractVersion: 1,
    default: "fs",
    entries: [
      { id: "fs", transport: "stdio", command: NODE_BIN, args: ["server.js", "--token", "should-not-appear"] },
    ],
  },
};

const TOOL_READY = {
  tools: {
    contractVersion: 1,
    default: "rg",
    entries: [{ id: "rg", command: NODE_BIN, args: ["--version", "should-not-appear"] }],
  },
};

describe("Integration: trust posture", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-trust-posture-int-"));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // A HOME with a settings file and an empty trust store (so the workspace is
  // untrusted by default and trust state is deterministic).
  function homeWith(settings: unknown): string {
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".oh-my-cli", "settings.json"), JSON.stringify(settings));
    return home;
  }

  function workspaceDir(): string {
    const ws = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
    return ws;
  }

  it("composes the posture as redacted JSON and exits 0", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema).toBe("oh-my-cli.trust-posture");
    expect(report.folderTrust.state).toBe("untrusted");
    expect(report.approval.mode).toBe("default");
    const mcp = report.extensions.surfaces.find((s: { kind: string }) => s.kind === "mcp");
    expect(mcp.state).toBe("ready");
    // Redaction: argument values never appear.
    expect(r.stdout + r.stderr).not.toContain("should-not-appear");
  });

  it("emits a human-readable text report by default", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Trust Posture");
    expect(r.stdout).toContain("Folder trust");
    expect(r.stdout).toContain("Extension readiness");
    expect(r.stdout).not.toContain("should-not-appear");
  });

  it("reports a trusted workspace via --trust", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--trust", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).folderTrust.state).toBe("trusted");
  });

  it("reflects yolo approval mode and its warning", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--approval-mode", "yolo", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.approval.mode).toBe("yolo");
    expect(report.sandbox.warnings.some((w: string) => /yolo/i.test(w))).toBe(true);
  });

  it("reports the MCP surface as declared via --no-probe", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--no-probe", "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const mcp = JSON.parse(r.stdout).extensions.surfaces.find((s: { kind: string }) => s.kind === "mcp");
    expect(mcp.state).toBe("declared");
  });

  it("reports the tool surface as ready, and declared via --no-probe", async () => {
    const home = homeWith(TOOL_READY);
    const ws = workspaceDir();
    const probed = await runCli(["--trust-posture", "--workspace", ws, "--output", "json"], { HOME: home });
    expect(probed.code).toBe(0);
    const tool = JSON.parse(probed.stdout).extensions.surfaces.find((s: { kind: string }) => s.kind === "tool");
    expect(tool.present).toBe(true);
    expect(tool.selectedId).toBe("rg");
    expect(tool.state).toBe("ready");
    expect(probed.stdout + probed.stderr).not.toContain("should-not-appear");

    const noProbe = await runCli(["--trust-posture", "--workspace", ws, "--no-probe", "--output", "json"], { HOME: home });
    expect(noProbe.code).toBe(0);
    const toolNoProbe = JSON.parse(noProbe.stdout).extensions.surfaces.find((s: { kind: string }) => s.kind === "tool");
    expect(toolNoProbe.state).toBe("declared");
  });

  it("still exits 0 and surfaces an invalid contract as a warning (audit, not a gate)", async () => {
    const home = homeWith({
      mcp: { contractVersion: 1, entries: [{ id: "fs", command: "node", apiKey: "sk-leaked" }] },
    });
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--output", "json"], { HOME: home });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.extensions.error).toMatch(/raw credential field/);
    expect(r.stdout + r.stderr).not.toContain("sk-leaked");
  });

  it("reports absent extensions (exit 0) when the settings file is missing", async () => {
    const emptyHome = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--output", "json"], { HOME: emptyHome });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.extensions.settingsFound).toBe(false);
    expect(report.extensions.surfaces.every((s: { present: boolean }) => !s.present)).toBe(true);
  });

  it("exits 2 on an invalid output format", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--output", "yaml"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("exits 2 on an invalid approval mode", async () => {
    const home = homeWith(MCP_READY);
    const ws = workspaceDir();
    const r = await runCli(["--trust-posture", "--workspace", ws, "--approval-mode", "bogus"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid approval mode");
  });
});
