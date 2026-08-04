import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

describe("Integration: performance diagnostics (--perf-report, Issue #572)", () => {
  let workspace: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-572i-home-"));
    // A generated wide+deep fixture tree with a skip dir and a dot dir.
    for (let i = 0; i < 12; i++) {
      const dir = path.join(workspace, `pkg${i}`, "src");
      fs.mkdirSync(dir, { recursive: true });
      for (let j = 0; j < 8; j++) {
        fs.writeFileSync(path.join(dir, `file${j}.ts`), `export const v${j} = ${j};\n`);
      }
    }
    let deep = path.join(workspace, "deep");
    fs.mkdirSync(deep);
    for (let i = 0; i < 10; i++) {
      deep = path.join(deep, `level${i}`);
      fs.mkdirSync(deep);
      fs.writeFileSync(path.join(deep, "leaf.txt"), "x\n");
    }
    fs.mkdirSync(path.join(workspace, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "node_modules", "dep", "index.js"), "x\n");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref\n");
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    for (const d of [workspace, homeDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
  });

  it("renders all four phases with budgets, verdicts, and honest details", async () => {
    const r = await runCli(["--perf-report", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Performance report");
    expect(r.stdout).toContain("discovery");
    expect(r.stdout).toContain("store-scan");
    expect(r.stdout).toContain("turn-log-scan");
    expect(r.stdout).toContain("memory");
    // Budgets are named on every phase line.
    expect(r.stdout).toContain("/ budget 2000 ms");
    expect(r.stdout).toContain("/ budget 500 ms");
    expect(r.stdout).toContain("/ budget 1000 ms");
    expect(r.stdout).toContain("/ budget 512 MB");
    // Discovery saw the generated files but skipped node_modules/.git contents.
    expect(r.stdout).toMatch(/1\d\d files|\d{3,} files/);
    expect(r.stdout).toContain("0 session(s)");
    expect(r.stdout).toMatch(/Overall: /);
    // The report never echoes file contents.
    expect(r.stdout).not.toContain("export const");
    // No ANSI in a headless read.
    expect(r.stdout).not.toMatch(/\x1b\[/);
  });

  it("emits a versioned JSON record with per-phase verdicts", async () => {
    const r = await runCli(["--perf-report", "--workspace", workspace, "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.perf");
    expect(parsed.v).toBe(1);
    expect(parsed.phases.map((p: { name: string }) => p.name)).toEqual([
      "discovery",
      "store-scan",
      "turn-log-scan",
      "memory",
    ]);
    for (const phase of parsed.phases) {
      expect(typeof phase.measured).toBe("number");
      expect(typeof phase.budget).toBe("number");
      expect(["ok", "exceeds"]).toContain(phase.verdict);
      expect(phase.verdict).toBe(phase.measured <= phase.budget ? "ok" : "exceeds");
    }
    expect(["ok", "exceeds"]).toContain(parsed.overall);
  });

  it("home-collapses the workspace path in the report", async () => {
    // A workspace inside HOME renders with the ~ collapse, never the raw home.
    const inner = path.join(homeDir, "inner-ws");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "a.txt"), "a\n");
    const r = await runCli(["--perf-report", "--workspace", inner], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("~/inner-ws");
    expect(r.stdout).not.toContain(homeDir);
  });

  it("fails closed (exit 2) for a missing workspace and a bad format", async () => {
    const missing = await runCli(
      ["--perf-report", "--workspace", path.join(workspace, "does-not-exist")],
      baseEnv,
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("not a readable directory");

    const bad = await runCli(
      ["--perf-report", "--workspace", workspace, "--output", "yaml"],
      baseEnv,
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid output format");
  });

  it("is read-only: the workspace and session store are untouched", async () => {
    const before = fs
      .readdirSync(workspace, { recursive: true })
      .map(String)
      .sort()
      .join("\n");
    const r = await runCli(["--perf-report", "--workspace", workspace], baseEnv);
    expect(r.code).toBe(0);
    const after = fs
      .readdirSync(workspace, { recursive: true })
      .map(String)
      .sort()
      .join("\n");
    expect(after).toBe(before);
    // The measurement wrote no session data (the sessions directory may be
    // created empty by the store constructor, as with every sibling surface).
    const sessionsDir = path.join(homeDir, ".oh-my-cli", "sessions");
    if (fs.existsSync(sessionsDir)) {
      expect(fs.readdirSync(sessionsDir)).toEqual([]);
    }
  });
});
