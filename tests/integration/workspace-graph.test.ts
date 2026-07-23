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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-graph-int-"));
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

describe("Integration: workspace graph (--list-workspaces)", () => {
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-graph-int-home-"));
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

  it("lists leased workspaces with clean/dirty state (JSON), read-only", async () => {
    const repo = makeRepo();
    const cleanPath = await createLease(repo, "task-clean", "agent-1");
    const dirtyPath = await createLease(repo, "task-dirty", "agent-2");
    fs.writeFileSync(path.join(dirtyPath, "c.txt"), "uncommitted\n");

    const headBefore = execFileSync("git", ["-C", cleanPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const r = await runCli(["--list-workspaces", "--workspace", repo, "--output", "json"], env);
    expect(r.code).toBe(0);
    const graph = JSON.parse(r.stdout);
    expect(graph.schema).toBe("oh-my-cli.worktree-graph");
    expect(graph.entries).toHaveLength(2);
    const flags = graph.entries.map((e: { dirty: boolean }) => e.dirty).sort();
    expect(flags).toEqual([false, true]);
    for (const e of graph.entries) {
      expect(e.branch).toMatch(/^lease\/wt-/);
      expect(e.head).toMatch(/^[0-9a-f]{12}$/);
    }

    // Read-only: the listed worktree is unchanged.
    const headAfter = execFileSync("git", ["-C", cleanPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it("reports an empty graph (text) when there are no leased workspaces", async () => {
    const repo = makeRepo();
    const r = await runCli(["--list-workspaces", "--workspace", repo], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Worktree graph");
    expect(r.stdout).toContain("workspaces: (none)");
  });

  it("exits 2 on a non-repository target", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-graph-int-norepo-"));
    tmpDirs.push(dir);
    const r = await runCli(["--list-workspaces", "--workspace", dir], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a git repository");
  });
});
