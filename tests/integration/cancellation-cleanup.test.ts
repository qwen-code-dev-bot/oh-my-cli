import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

const tmpDirs: string[] = [];
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-cancel-int-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

describe("Integration: cancellation cleanup (--cancel-worktree)", () => {
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-cancel-int-home-"));
    tmpDirs.push(homeDir);
    env = { HOME: homeDir, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };
  });

  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  async function createLease(repo: string, task: string, agent: string): Promise<string> {
    const r = await runCli(
      ["--create-worktree", "--task-identity", task, "--agent-identity", agent, "--workspace", repo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.ok).toBe(true);
    return result.lease.worktreePath as string;
  }

  it("cancels a clean lease via the CLI: worktree removed, branch preserved", async () => {
    const repo = makeRepo();
    const wtPath = await createLease(repo, "task-clean", "agent-1");
    expect(fs.existsSync(wtPath)).toBe(true);

    const r = await runCli(
      ["--cancel-worktree", "--task-identity", "task-clean", "--agent-identity", "agent-1", "--workspace", repo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
    // The lease branch is preserved.
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "lease/wt-*"], { encoding: "utf8" });
    expect(branches.trim()).not.toBe("");
  });

  it("refuses to cancel a dirty lease without --cancel-force (exit 1)", async () => {
    const repo = makeRepo();
    const wtPath = await createLease(repo, "task-dirty", "agent-1");
    fs.writeFileSync(path.join(wtPath, "c.txt"), "uncommitted\n");

    const r = await runCli(
      ["--cancel-worktree", "--task-identity", "task-dirty", "--agent-identity", "agent-1", "--workspace", repo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(1);
    const result = JSON.parse(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("uncommitted_changes");
    // The worktree is retained.
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it("discards uncommitted work with --cancel-force (exit 0)", async () => {
    const repo = makeRepo();
    const wtPath = await createLease(repo, "task-force", "agent-1");
    fs.writeFileSync(path.join(wtPath, "c.txt"), "uncommitted\n");

    const r = await runCli(
      ["--cancel-worktree", "--cancel-force", "--task-identity", "task-force", "--agent-identity", "agent-1", "--workspace", repo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("rejects combining --cancel-worktree with --clean-worktree (exit 2)", async () => {
    const repo = makeRepo();
    const r = await runCli(
      ["--cancel-worktree", "--clean-worktree", "--task-identity", "t", "--agent-identity", "a", "--workspace", repo],
      env,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("choose one of");
  });
});
