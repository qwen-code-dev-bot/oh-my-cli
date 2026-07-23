import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktreeLease,
  cancelWorktreeLease,
  formatWorktreeCancelResult,
  WORKTREE_LEASE_SCHEMA,
  WORKTREE_LEASE_VERSION,
} from "../../src/worktree-lease.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

// A temp repo with one commit on `main`.
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-cancel-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function createLease(repo: string): string {
  const result = createWorktreeLease({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" });
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.lease.worktreePath;
}

describe("cancelWorktreeLease", () => {
  it("cancels a clean lease: removes the worktree, preserves the branch", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo);
    expect(fs.existsSync(wtPath)).toBe(true);

    const result = cancelWorktreeLease({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cancelled).toBe(true);
      expect(result.worktreeRemoved).toBe(true);
      expect(result.forced).toBe(false);
    }
    // The worktree is gone but the lease branch is preserved.
    expect(fs.existsSync(wtPath)).toBe(false);
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "lease/wt-*"], { encoding: "utf8" });
    expect(branches.trim()).not.toBe("");
  });

  it("preserves committed work and reports the preserved commits", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo);
    fs.writeFileSync(path.join(wtPath, "b.txt"), "agent work\n");
    git(wtPath, "add", "b.txt");
    git(wtPath, "commit", "-q", "-m", "agent commit");

    const result = cancelWorktreeLease({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cancelled).toBe(true);
      expect(result.preserved.commits.map((c) => c.subject)).toContain("agent commit");
      // The branch (with the commit) still exists.
      expect(execFileSync("git", ["-C", repo, "branch", "--list", result.lease.branch], { encoding: "utf8" }).trim()).not.toBe("");
    }
  });

  it("fails closed on uncommitted work without --cancel-force", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo);
    fs.writeFileSync(path.join(wtPath, "c.txt"), "uncommitted\n");

    const result = cancelWorktreeLease({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("uncommitted_changes");
    }
    // The worktree is retained (not removed).
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it("discards uncommitted work with --cancel-force", () => {
    const repo = makeRepo();
    const wtPath = createLease(repo);
    fs.writeFileSync(path.join(wtPath, "c.txt"), "uncommitted\n");

    const result = cancelWorktreeLease({ repo, taskIdentity: "task-1", agentIdentity: "agent-1" }, { force: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cancelled).toBe(true);
      expect(result.forced).toBe(true);
      expect(result.worktreeRemoved).toBe(true);
    }
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("is an idempotent no-op when the lease is already absent", () => {
    const repo = makeRepo();
    const result = cancelWorktreeLease({ repo, taskIdentity: "never-leased", agentIdentity: "agent-x" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cancelled).toBe(false);
      expect(result.worktreeRemoved).toBe(false);
    }
  });

  it("fails closed when identities are missing", () => {
    const repo = makeRepo();
    const result = cancelWorktreeLease({ repo, taskIdentity: "", agentIdentity: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
  });
});

describe("formatWorktreeCancelResult", () => {
  it("renders a successful cancellation with preserved commits", () => {
    const text = formatWorktreeCancelResult({
      ok: true,
      cancelled: true,
      worktreeRemoved: true,
      forced: false,
      lease: {
        schema: WORKTREE_LEASE_SCHEMA,
        v: WORKTREE_LEASE_VERSION,
        leaseId: "abc123",
        branch: "lease/wt-abc123",
        worktreePath: "~/repo/.oh-my-cli/worktrees/abc123",
        baseSha: "def456",
        taskIdentity: "task",
        agentIdentity: "agent",
      },
      preserved: {
        branch: "lease/wt-abc123",
        commits: [{ sha: "1234567890ab", subject: "agent commit" }],
        truncatedCommits: 0,
      },
    });
    expect(text).toContain("Worktree lease cancellation");
    expect(text).toContain("status:   cancelled");
    expect(text).toContain("branch:   lease/wt-abc123 (preserved)");
    expect(text).toContain("(removed)");
    expect(text).toContain("preserved commits: 1");
    expect(text).toContain("agent commit");
  });

  it("renders a refusal", () => {
    const text = formatWorktreeCancelResult({
      ok: false,
      reason: "uncommitted_changes",
      message: "lease worktree has 1 uncommitted change(s) that would be lost",
    });
    expect(text).toContain("result:   refused");
    expect(text).toContain("reason:   uncommitted_changes");
  });
});
