import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
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

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tp-cli-"));
  dirs.push(d);
  return d;
}

function write(dir: string, rel: string, content = ""): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Integration: task planning (--plan)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and renders a human plan for a populated repo", async () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
    write(dir, "package-lock.json", "{}");
    initRepo(dir);
    const r = await runCli(["--plan", "add a feature", "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Task plan (oh-my-cli.plan v1)");
    expect(r.stdout).toContain("Objective : add a feature");
    expect(r.stdout).toContain("Toolchain : npm");
    expect(r.stdout).toContain("- tsc");
    expect(r.stdout).toContain("- vitest run");
  });

  it("emits stable JSON with the plan schema", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }));
    initRepo(dir);
    const r = await runCli(["--plan", "fix a bug", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout.trim());
    expect(plan.schema).toBe("oh-my-cli.plan");
    expect(plan.v).toBe(1);
    expect(plan.objective).toBe("fix a bug");
    expect(plan.steps.map((s: { phase: string }) => s.phase)).toEqual(["understand", "implement", "verify", "review"]);
    expect(plan.verifyCommands).toEqual(["tsc", "vitest run", "eslint ."]);
  });

  it("dogfoods against this repository (vitest + tsc verify commands)", async () => {
    const r = await runCli(["--plan", "add a feature", "--workspace", REPO_ROOT, "--output", "json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout.trim());
    expect(plan.toolchain).toContain("npm");
    expect(plan.verifyCommands).toContain("vitest run tests/unit");
    expect(plan.verifyCommands).toContain("tsc");
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    initRepo(dir);
    const text = await runCli(["--plan", `deploy --key ${SECRET}`, "--workspace", dir]);
    const json = await runCli(["--plan", `deploy --key ${SECRET}`, "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(dir);
  });

  it("handles an empty directory gracefully (exit 0, no verify commands)", async () => {
    const dir = tmp();
    const r = await runCli(["--plan", "do something", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout.trim());
    expect(plan.verifyCommands).toEqual([]);
    expect(plan.toolchain).toEqual([]);
  });

  it("rejects an empty task description (exit 2)", async () => {
    const r = await runCli(["--plan", "", "--workspace", tmp()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--plan requires a non-empty task description");
  });

  it("rejects an invalid --output format", async () => {
    const r = await runCli(["--plan", "x", "--workspace", tmp(), "--output", "yaml"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
