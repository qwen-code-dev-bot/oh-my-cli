import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktreeLease,
  collectWorktreeGraph,
  formatWorktreeGraph,
  WORKTREE_GRAPH_SCHEMA,
  WORKTREE_GRAPH_VERSION,
} from "../../src/worktree-lease.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-graph-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  // Mirror the product repo: the lease worktree root is git-ignored so carving
  // worktrees does not dirty the parent.
  fs.writeFileSync(path.join(repo, ".gitignore"), ".oh-my-cli/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", ".gitignore", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function createLease(repo: string, task: string, agent: string): string {
  const result = createWorktreeLease({ repo, taskIdentity: task, agentIdentity: agent });
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.lease.worktreePath;
}

describe("collectWorktreeGraph", () => {
  it("reports an empty graph when there are no leased workspaces", () => {
    const repo = makeRepo();
    const graph = collectWorktreeGraph({ repo });
    expect(graph.schema).toBe(WORKTREE_GRAPH_SCHEMA);
    expect(graph.v).toBe(WORKTREE_GRAPH_VERSION);
    expect(graph.entries).toEqual([]);
    expect(graph.truncated).toBe(0);
  });

  it("lists leased workspaces with branch, head, and clean state", () => {
    const repo = makeRepo();
    createLease(repo, "task-1", "agent-1");
    const graph = collectWorktreeGraph({ repo });
    expect(graph.entries).toHaveLength(1);
    const entry = graph.entries[0];
    expect(entry.branch).toMatch(/^lease\/wt-/);
    expect(entry.head).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.dirty).toBe(false);
  });

  it("classifies a dirty workspace correctly", () => {
    const repo = makeRepo();
    const cleanPath = createLease(repo, "task-clean", "agent-1");
    const dirtyPath = createLease(repo, "task-dirty", "agent-2");
    fs.writeFileSync(path.join(dirtyPath, "c.txt"), "uncommitted\n");
    void cleanPath;

    const graph = collectWorktreeGraph({ repo });
    expect(graph.entries).toHaveLength(2);
    const byPath = new Map(graph.entries.map((e) => [e.worktreePath, e.dirty]));
    // Exactly one dirty and one clean.
    const dirtyFlags = graph.entries.map((e) => e.dirty).sort();
    expect(dirtyFlags).toEqual([false, true]);
    expect(byPath.size).toBe(2);
  });

  it("does not mutate the worktrees it lists", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo, "task-ro", "agent-1");
    const headBefore = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    collectWorktreeGraph({ repo });
    const headAfter = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it("throws on a non-repository target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-graph-norepo-"));
    tmpDirs.push(dir);
    expect(() => collectWorktreeGraph({ repo: dir })).toThrow(/not a git repository/);
  });
});

describe("formatWorktreeGraph", () => {
  it("renders an empty graph", () => {
    const text = formatWorktreeGraph({
      schema: WORKTREE_GRAPH_SCHEMA,
      v: WORKTREE_GRAPH_VERSION,
      worktreeRoot: "~/repo/.oh-my-cli/worktrees",
      entries: [],
      truncated: 0,
    });
    expect(text).toContain("Worktree graph");
    expect(text).toContain("workspaces: (none)");
  });

  it("renders a populated graph with state", () => {
    const text = formatWorktreeGraph({
      schema: WORKTREE_GRAPH_SCHEMA,
      v: WORKTREE_GRAPH_VERSION,
      worktreeRoot: "~/repo/.oh-my-cli/worktrees",
      entries: [
        { worktreePath: "~/repo/.oh-my-cli/worktrees/abc", branch: "lease/wt-abc", head: "1234567890ab", dirty: false },
        { worktreePath: "~/repo/.oh-my-cli/worktrees/def", branch: "lease/wt-def", head: "abcdef123456", dirty: true },
      ],
      truncated: 0,
    });
    expect(text).toContain("workspaces: 2");
    expect(text).toContain("lease/wt-abc");
    expect(text).toContain("state: clean");
    expect(text).toContain("state: dirty");
  });
});
