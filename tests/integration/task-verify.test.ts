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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tv-cli-"));
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

const SECRET = "ghp_" + "a".repeat(36);

describe("Integration: task verification (--verify-task)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and renders a human verdict for a passing repo", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "true", test: "true" } }));
    initRepo(dir);
    const r = await runCli(["--verify-task", "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Task verification (oh-my-cli.task-verify v1)");
    expect(r.stdout).toContain("Verdict: pass");
    expect(r.stdout).toContain("[PASS] build");
    expect(r.stdout).toContain("[PASS] test");
  });

  it("emits stable JSON with the task-verify schema", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "true", test: "true" } }));
    initRepo(dir);
    const r = await runCli(["--verify-task", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.schema).toBe("oh-my-cli.task-verify");
    expect(report.v).toBe(1);
    expect(report.verdict).toBe("pass");
    expect(report.head).toMatch(/^[0-9a-f]{40}$/);
    expect(report.results.map((x: { name: string }) => x.name)).toEqual(["build", "test"]);
    for (const x of report.results as Record<string, unknown>[]) {
      expect(x).toHaveProperty("exitCode");
      expect(x).toHaveProperty("passed");
      expect(x).toHaveProperty("durationMs");
      expect(x).toHaveProperty("outputTail");
    }
  });

  it("exits 1 when a detected command fails", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { build: "true", test: "exit 7" } }));
    initRepo(dir);
    const r = await runCli(["--verify-task", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("fail");
    expect(report.results.find((x: { name: string }) => x.name === "test").exitCode).toBe(7);
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const dir = tmp();
    write(dir, "leak.txt", `${SECRET}\n${dir}/src/secret.ts`);
    write(dir, "package.json", JSON.stringify({ scripts: { test: "cat leak.txt" } }));
    initRepo(dir);
    const text = await runCli(["--verify-task", "--workspace", dir]);
    const json = await runCli(["--verify-task", "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(dir);
  });

  it("handles an empty directory gracefully (exit 0, no verify commands)", async () => {
    const dir = tmp();
    const r = await runCli(["--verify-task", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("no-verify-commands");
    expect(report.results).toEqual([]);
  });

  it("rejects an invalid --output format (exit 2)", async () => {
    const r = await runCli(["--verify-task", "--workspace", tmp(), "--output", "yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
