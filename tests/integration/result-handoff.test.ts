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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-handoff-int-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".oh-my-cli/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", ".gitignore", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

describe("Integration: result handoff (--handoff)", () => {
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-handoff-int-home-"));
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

  it("emits a handoff brief (JSON) for a lease that made a commit, read-only", async () => {
    const repo = makeRepo();
    const wtPath = await createLease(repo, "task-1", "agent-1");
    fs.writeFileSync(path.join(wtPath, "b.txt"), "agent work\n");
    git(wtPath, "add", "b.txt");
    git(wtPath, "commit", "-q", "-m", "agent commit");
    const headBefore = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const r = await runCli(
      ["--handoff", "--task-identity", "task-1", "--agent-identity", "agent-1", "--workspace", repo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const handoff = JSON.parse(r.stdout);
    expect(handoff.schema).toBe("oh-my-cli.worktree-handoff");
    expect(handoff.present).toBe(true);
    expect(handoff.branch).toMatch(/^lease\/wt-/);
    expect(handoff.commits.map((c: { subject: string }) => c.subject)).toContain("agent commit");
    expect(handoff.changedPaths).toContain("b.txt");
    expect(handoff.dirty).toBe(false);

    // Read-only: the worktree is unchanged.
    const headAfter = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it("emits an absent handoff (text) for an unknown lease", async () => {
    const repo = makeRepo();
    const r = await runCli(
      ["--handoff", "--task-identity", "ghost", "--agent-identity", "ghost", "--workspace", repo],
      env,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Worktree handoff");
    expect(r.stdout).toContain("status:   absent (no such lease)");
  });

  it("exits 2 when --task-identity is missing", async () => {
    const repo = makeRepo();
    const r = await runCli(["--handoff", "--agent-identity", "a", "--workspace", repo], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--task-identity");
  });
});
