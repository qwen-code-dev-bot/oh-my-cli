import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
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

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-cli-"));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A committed git repo so a lease has a commit to base from; returns its sha.
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function commitInWorktree(wt: string, file: string, content: string): void {
  fs.writeFileSync(path.join(wt, file), content);
  git(wt, ["add", "-A"]);
  git(wt, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", `add ${file}`]);
}

async function createLease(
  repo: string,
  root: string,
  task: string,
  agent: string,
): Promise<{ leaseId: string; branch: string; worktreePath: string }> {
  const r = await runCli([
    "--create-worktree", "--workspace", repo, "--worktree-root", root,
    "--task-identity", task, "--agent-identity", agent, "--output", "json",
  ]);
  expect(r.code).toBe(0);
  const res = JSON.parse(r.stdout.trim());
  expect(res.ok).toBe(true);
  return { leaseId: res.lease.leaseId, branch: res.lease.branch, worktreePath: path.join(root, res.lease.leaseId) };
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("Integration: leased worktrees (--create-worktree / --clean-worktree)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("creates a leased worktree (exit 0) with versioned JSON evidence", async () => {
    const repo = tmp();
    const head = initRepo(repo);
    const root = tmp();
    const r = await runCli([
      "--create-worktree", "--workspace", repo, "--worktree-root", root,
      "--task-identity", "task-A", "--agent-identity", "agent-1", "--output", "json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout.trim());
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.lease.schema).toBe("oh-my-cli.worktree-lease");
    expect(res.lease.baseSha).toBe(head);
    expect(fs.existsSync(path.join(root, res.lease.leaseId))).toBe(true);
  });

  it("renders human-readable lease evidence", async () => {
    const repo = tmp();
    initRepo(repo);
    const r = await runCli([
      "--create-worktree", "--workspace", repo, "--worktree-root", tmp(),
      "--task-identity", "task-A", "--agent-identity", "agent-1",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Worktree lease (oh-my-cli.worktree-lease v1)");
    expect(r.stdout).toContain("status:   created");
  });

  it("is idempotent across a repeated create (exit 0, created:false)", async () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const args = [
      "--create-worktree", "--workspace", repo, "--worktree-root", root,
      "--task-identity", "task-A", "--agent-identity", "agent-1", "--output", "json",
    ];
    await runCli(args);
    const again = await runCli(args);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout.trim()).created).toBe(false);
  });

  it("isolates two mutating agents in separate worktrees for one task", async () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const a = await createLease(repo, root, "task-A", "agent-1");
    const b = await createLease(repo, root, "task-A", "agent-2");
    expect(a.leaseId).not.toBe(b.leaseId);

    // Agent 1 mutates only its own worktree.
    commitInWorktree(a.worktreePath, "feature.txt", "agent-1 work\n");
    expect(fs.existsSync(path.join(a.worktreePath, "feature.txt"))).toBe(true);
    // The change is invisible to agent 2's worktree and to the parent.
    expect(fs.existsSync(path.join(b.worktreePath, "feature.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });

  it("cleans a merged lease (exit 0) and leaves the parent intact", async () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const a = await createLease(repo, root, "task-A", "agent-1");
    commitInWorktree(a.worktreePath, "feature.txt", "work\n");
    // Verified completion: integrate the lease branch into the parent.
    git(repo, ["-c", "user.email=t@e.com", "-c", "user.name=t", "merge", "--no-ff", "-m", "merge lease", a.branch]);

    const r = await runCli([
      "--clean-worktree", "--workspace", repo, "--worktree-root", root,
      "--task-identity", "task-A", "--agent-identity", "agent-1", "--output", "json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout.trim());
    expect(res.ok).toBe(true);
    expect(res.cleaned).toBe(true);
    expect(fs.existsSync(a.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
  });

  it("retains (exit 1) a lease whose branch has unmerged commits", async () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const b = await createLease(repo, root, "task-B", "agent-2");
    commitInWorktree(b.worktreePath, "feature.txt", "unmerged\n"); // never merged

    const r = await runCli([
      "--clean-worktree", "--workspace", repo, "--worktree-root", root,
      "--task-identity", "task-B", "--agent-identity", "agent-2", "--output", "json",
    ]);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout.trim());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unmerged_commits");
    expect(fs.existsSync(b.worktreePath)).toBe(true); // retained safely
  });

  it("treats cleaning an absent lease as an idempotent no-op (exit 0)", async () => {
    const repo = tmp();
    initRepo(repo);
    const r = await runCli([
      "--clean-worktree", "--workspace", repo, "--worktree-root", tmp(),
      "--task-identity", "never", "--agent-identity", "made", "--output", "json",
    ]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout.trim());
    expect(res.ok).toBe(true);
    expect(res.cleaned).toBe(false);
  });

  it("refuses (exit 1) a dirty parent and a non-repository before mutating", async () => {
    const dirty = tmp();
    initRepo(dirty);
    fs.writeFileSync(path.join(dirty, "dirty.txt"), "x\n");
    const dirtyRes = await runCli([
      "--create-worktree", "--workspace", dirty, "--worktree-root", tmp(),
      "--task-identity", "task-A", "--agent-identity", "agent-1", "--output", "json",
    ]);
    expect(dirtyRes.code).toBe(1);
    expect(JSON.parse(dirtyRes.stdout.trim()).reason).toBe("dirty");

    const nonRepo = tmp();
    const nonRes = await runCli([
      "--create-worktree", "--workspace", nonRepo, "--worktree-root", tmp(),
      "--task-identity", "task-A", "--agent-identity", "agent-1", "--output", "json",
    ]);
    expect(nonRes.code).toBe(1);
    expect(JSON.parse(nonRes.stdout.trim()).reason).toBe("non_repository");
  });

  it("never leaks a secret in either output mode", async () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const args = [
      "--create-worktree", "--workspace", repo, "--worktree-root", root,
      "--task-identity", `task ${SECRET}`, "--agent-identity", `agent ${SECRET}`,
    ];
    const text = await runCli(args);
    const json = await runCli([...args, "--output", "json"]);
    const combined = text.stdout + json.stdout + text.stderr + json.stderr;
    expect(combined).not.toContain(SECRET);
  });

  it("exits 2 on usage errors", async () => {
    const repo = tmp();
    initRepo(repo);

    const noTask = await runCli(["--create-worktree", "--workspace", repo, "--agent-identity", "a"]);
    expect(noTask.code).toBe(2);
    expect(noTask.stderr).toContain("--task-identity");

    const noAgent = await runCli(["--create-worktree", "--workspace", repo, "--task-identity", "t"]);
    expect(noAgent.code).toBe(2);
    expect(noAgent.stderr).toContain("--agent-identity");

    const both = await runCli([
      "--create-worktree", "--clean-worktree", "--workspace", repo,
      "--task-identity", "t", "--agent-identity", "a",
    ]);
    expect(both.code).toBe(2);

    const badOutput = await runCli([
      "--create-worktree", "--workspace", repo, "--task-identity", "t",
      "--agent-identity", "a", "--output", "yaml",
    ]);
    expect(badOutput.code).toBe(2);
  });
});
