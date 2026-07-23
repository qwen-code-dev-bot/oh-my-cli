import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktreeLease,
  collectWorktreeHandoff,
  formatWorktreeHandoff,
  WORKTREE_HANDOFF_SCHEMA,
  WORKTREE_HANDOFF_VERSION,
} from "../../src/worktree-lease.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-handoff-"));
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

describe("collectWorktreeHandoff", () => {
  it("reports an absent handoff when no lease exists for the identity", () => {
    const repo = makeRepo();
    const handoff = collectWorktreeHandoff({ repo, taskIdentity: "nope", agentIdentity: "nada" });
    expect(handoff.schema).toBe(WORKTREE_HANDOFF_SCHEMA);
    expect(handoff.v).toBe(WORKTREE_HANDOFF_VERSION);
    expect(handoff.present).toBe(false);
    expect(handoff.commits).toEqual([]);
    expect(handoff.changedPaths).toEqual([]);
  });

  it("reports the branch, head, commits, and changed paths for a lease that made a commit", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo, "task-1", "agent-1");
    fs.writeFileSync(path.join(wtPath, "b.txt"), "agent work\n");
    git(wtPath, "add", "b.txt");
    git(wtPath, "commit", "-q", "-m", "agent commit");

    const handoff = collectWorktreeHandoff({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" });
    expect(handoff.present).toBe(true);
    expect(handoff.branch).toMatch(/^lease\/wt-/);
    expect(handoff.head).toMatch(/^[0-9a-f]{12}$/);
    expect(handoff.dirty).toBe(false);
    expect(handoff.commits.map((c) => c.subject)).toContain("agent commit");
    expect(handoff.changedPaths).toContain("b.txt");
  });

  it("reports a dirty state for a lease with uncommitted work", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo, "task-dirty", "agent-1");
    fs.writeFileSync(path.join(wtPath, "c.txt"), "uncommitted\n");

    const handoff = collectWorktreeHandoff({ repo, taskIdentity: "task-dirty", agentIdentity: "agent-1" });
    expect(handoff.present).toBe(true);
    expect(handoff.dirty).toBe(true);
  });

  it("redacts secret-shaped commit subjects", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo, "task-secret", "agent-1");
    fs.writeFileSync(path.join(wtPath, "d.txt"), "x\n");
    git(wtPath, "add", "d.txt");
    git(wtPath, "commit", "-q", "-m", "add sk-aaaaaaaaaaaaaaaaaaaa token");

    const handoff = collectWorktreeHandoff({ repo, taskIdentity: "task-secret", agentIdentity: "agent-1" });
    const subject = handoff.commits.map((c) => c.subject).join(" ");
    expect(subject).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
    expect(subject).toContain("[REDACTED]");
  });

  it("does not mutate the worktree it inspects", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo, "task-ro", "agent-1");
    fs.writeFileSync(path.join(wtPath, "b.txt"), "x\n");
    git(wtPath, "add", "b.txt");
    git(wtPath, "commit", "-q", "-m", "c");
    const headBefore = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    collectWorktreeHandoff({ repo, taskIdentity: "task-ro", agentIdentity: "agent-1" });
    const headAfter = execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it("throws when identities are missing", () => {
    const repo = makeRepo();
    expect(() => collectWorktreeHandoff({ repo, taskIdentity: "", agentIdentity: "" })).toThrow(/task-identity/);
  });

  it("throws on a non-repository target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-handoff-norepo-"));
    tmpDirs.push(dir);
    expect(() => collectWorktreeHandoff({ repo: dir, taskIdentity: "t", agentIdentity: "a" })).toThrow(/not a git repository/);
  });
});

describe("formatWorktreeHandoff", () => {
  it("renders an absent handoff", () => {
    const text = formatWorktreeHandoff({
      schema: WORKTREE_HANDOFF_SCHEMA,
      v: WORKTREE_HANDOFF_VERSION,
      leaseId: "abc123",
      branch: "lease/wt-abc123",
      worktreePath: "~/repo/.oh-my-cli/worktrees/abc123",
      present: false,
      head: "",
      dirty: false,
      commits: [],
      truncatedCommits: 0,
      changedPaths: [],
      truncatedPaths: 0,
    });
    expect(text).toContain("Worktree handoff");
    expect(text).toContain("status:   absent (no such lease)");
  });

  it("renders a present handoff with commits and changed paths", () => {
    const text = formatWorktreeHandoff({
      schema: WORKTREE_HANDOFF_SCHEMA,
      v: WORKTREE_HANDOFF_VERSION,
      leaseId: "abc123",
      branch: "lease/wt-abc123",
      worktreePath: "~/repo/.oh-my-cli/worktrees/abc123",
      present: true,
      head: "1234567890ab",
      dirty: false,
      commits: [{ sha: "1234567890ab", subject: "agent commit" }],
      truncatedCommits: 0,
      changedPaths: ["b.txt"],
      truncatedPaths: 0,
    });
    expect(text).toContain("head:     1234567890ab");
    expect(text).toContain("state:    clean");
    expect(text).toContain("commits:  1");
    expect(text).toContain("agent commit");
    expect(text).toContain("changed paths: 1");
    expect(text).toContain("b.txt");
  });
});
