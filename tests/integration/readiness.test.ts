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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rr-cli-"));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string, withTest = true): void {
  fs.mkdirSync(dir, { recursive: true });
  if (withTest) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

function bareRemote(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare"]);
  return dir;
}

function healthyRepo(): string {
  const repo = tmp();
  initRepo(repo, true);
  git(repo, ["remote", "add", "origin", bareRemote(tmp())]);
  return repo;
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("Integration: repository readiness (--readiness)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and reports a healthy repository as ready (human output)", async () => {
    const r = await runCli(["--readiness", "--workspace", healthyRepo()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Repository readiness (oh-my-cli.readiness v1)");
    expect(r.stdout).toContain("Ready: no blocker detected.");
  });

  it("emits stable JSON with the readiness schema for a healthy repo", async () => {
    const r = await runCli(["--readiness", "--workspace", healthyRepo(), "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.schema).toBe("oh-my-cli.readiness");
    expect(report.v).toBe(1);
    expect(report.ready).toBe(true);
    expect(report.blocker).toBeNull();
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual([
      "worktree",
      "branch",
      "test-command",
      "executable",
      "remote",
    ]);
  });

  it("exits 1 and explains a dirty worktree", async () => {
    const repo = healthyRepo();
    fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted");
    const r = await runCli(["--readiness", "--workspace", repo, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).blocker).toBe("worktree");
  });

  it("exits 1 and explains a detached HEAD", async () => {
    const repo = tmp();
    initRepo(repo, true);
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git(repo, ["checkout", "-q", sha]);
    const r = await runCli(["--readiness", "--workspace", repo, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).blocker).toBe("branch");
  });

  it("exits 1 and explains a wrong branch via --expected-branch", async () => {
    const r = await runCli(["--readiness", "--workspace", healthyRepo(), "--expected-branch", "release", "--output", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.blocker).toBe("branch");
    expect(report.checks.find((c: { id: string }) => c.id === "branch").detail).toContain('expected "release"');
  });

  it("exits 1 and explains a missing test command", async () => {
    const repo = tmp();
    initRepo(repo, false);
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);
    const r = await runCli(["--readiness", "--workspace", repo, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).blocker).toBe("test-command");
  });

  it("exits 1 and explains an unreachable remote", async () => {
    const repo = tmp();
    initRepo(repo, true);
    git(repo, ["remote", "add", "origin", "/no/such/repo.git"]);
    const r = await runCli(["--readiness", "--workspace", repo, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).blocker).toBe("remote");
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const repo = tmp();
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);

    const text = await runCli(["--readiness", "--workspace", repo]);
    const json = await runCli(["--readiness", "--workspace", repo, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(repo);
  });

  it("rejects an invalid --output format", async () => {
    const r = await runCli(["--readiness", "--workspace", healthyRepo(), "--output", "yaml"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
