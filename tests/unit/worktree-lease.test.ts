import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveLeaseIdentity,
  createWorktreeLease,
  cleanWorktreeLease,
  formatWorktreeLeaseResult,
  WORKTREE_LEASE_SCHEMA,
  WORKTREE_LEASE_VERSION,
} from "../../src/worktree-lease.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-lease-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A committed git repo so the lease has a commit to base from; returns its sha.
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

// Commit a new file inside a worktree, on its (already checked-out) branch.
function commitInWorktree(wt: string, file: string, content: string): void {
  fs.writeFileSync(path.join(wt, file), content);
  git(wt, ["add", "-A"]);
  git(wt, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", `add ${file}`]);
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("deriveLeaseIdentity", () => {
  it("is deterministic and uses a safe branch format", () => {
    const a = deriveLeaseIdentity({ repoKey: "/r/.git", taskIdentity: "t1", agentIdentity: "a1" });
    const b = deriveLeaseIdentity({ repoKey: "/r/.git", taskIdentity: "t1", agentIdentity: "a1" });
    expect(a).toEqual(b);
    expect(a.leaseId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.branch).toBe(`lease/wt-${a.leaseId}`);
  });

  it("is collision-safe: distinct task, agent, or repo yields a distinct lease", () => {
    const base = deriveLeaseIdentity({ repoKey: "/r/.git", taskIdentity: "t1", agentIdentity: "a1" });
    const otherAgent = deriveLeaseIdentity({ repoKey: "/r/.git", taskIdentity: "t1", agentIdentity: "a2" });
    const otherTask = deriveLeaseIdentity({ repoKey: "/r/.git", taskIdentity: "t2", agentIdentity: "a1" });
    const otherRepo = deriveLeaseIdentity({ repoKey: "/other/.git", taskIdentity: "t1", agentIdentity: "a1" });
    const ids = new Set([base.leaseId, otherAgent.leaseId, otherTask.leaseId, otherRepo.leaseId]);
    expect(ids.size).toBe(4);
  });
});

describe("createWorktreeLease", () => {
  it("creates an isolated worktree and branch from a clean repository", () => {
    const repo = tmp();
    const head = initRepo(repo);
    const root = tmp();
    const res = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.lease.schema).toBe(WORKTREE_LEASE_SCHEMA);
    expect(res.lease.v).toBe(WORKTREE_LEASE_VERSION);
    expect(res.lease.baseSha).toBe(head);
    expect(res.lease.branch).toMatch(/^lease\/wt-[0-9a-f]{16}$/);
    // The branch and worktree now exist.
    expect(execFileSync("git", ["-C", repo, "rev-parse", "--verify", res.lease.branch], { encoding: "utf8" }).trim()).toBeTruthy();
    expect(fs.existsSync(path.join(root, res.lease.leaseId))).toBe(true);
  });

  it("is idempotent: re-creating the same lease returns it without a second mutation", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const opts = { repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root };
    const first = createWorktreeLease(opts);
    const second = createWorktreeLease(opts);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.lease.leaseId).toBe(first.lease.leaseId);
    expect(second.lease.branch).toBe(first.lease.branch);
  });

  it("lets two agents hold distinct, coexisting worktrees for one task", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const a = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root });
    const b = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-2", worktreeRoot: root });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.lease.leaseId).not.toBe(b.lease.leaseId);
    expect(fs.existsSync(path.join(root, a.lease.leaseId))).toBe(true);
    expect(fs.existsSync(path.join(root, b.lease.leaseId))).toBe(true);
  });

  it("refuses a non-repository target before mutating", () => {
    const repo = tmp(); // empty dir, not a git repo
    const res = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: tmp() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("non_repository");
  });

  it("refuses a dirty parent worktree before mutating", () => {
    const repo = tmp();
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n");
    const res = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: tmp() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("dirty");
  });

  it("refuses an ambiguous target (missing identity)", () => {
    const repo = tmp();
    initRepo(repo);
    const res = createWorktreeLease({ repo, taskIdentity: "  ", agentIdentity: "agent-1", worktreeRoot: tmp() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("ambiguous");
  });

  it("refuses an already-leased identity left in a partial state", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const opts = { repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root };
    const first = createWorktreeLease(opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Simulate an interrupted lifecycle: the worktree is gone but the branch lingers.
    git(repo, ["worktree", "remove", "--force", path.join(root, first.lease.leaseId)]);
    const again = createWorktreeLease(opts);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("already_leased");
  });
});

describe("cleanWorktreeLease", () => {
  it("cleans a merged lease (worktree + branch removed, parent intact)", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const opts = { repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root };
    const created = createWorktreeLease(opts);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const wt = path.join(root, created.lease.leaseId);
    commitInWorktree(wt, "feature.txt", "work\n");
    // Verify completion: merge the lease branch into the parent.
    git(repo, ["-c", "user.email=t@e.com", "-c", "user.name=t", "merge", "--no-ff", "-m", "merge lease", created.lease.branch]);

    const parentHeadBefore = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const res = cleanWorktreeLease(opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cleaned).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(repo, created.lease.branch)).toBe(false);
    // The parent worktree is untouched.
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(parentHeadBefore);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
  });

  it("refuses to clean a lease with uncommitted changes (retained safely)", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const opts = { repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root };
    const created = createWorktreeLease(opts);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const wt = path.join(root, created.lease.leaseId);
    fs.writeFileSync(path.join(wt, "wip.txt"), "uncommitted\n"); // not committed

    const res = cleanWorktreeLease(opts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("uncommitted_changes");
    expect(fs.existsSync(wt)).toBe(true); // retained
  });

  it("refuses to delete a branch with unmerged commits (retained safely)", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const opts = { repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: root };
    const created = createWorktreeLease(opts);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const wt = path.join(root, created.lease.leaseId);
    commitInWorktree(wt, "feature.txt", "unmerged work\n"); // committed but never merged

    const res = cleanWorktreeLease(opts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unmerged_commits");
    expect(fs.existsSync(wt)).toBe(true); // retained
    expect(execFileSync("git", ["-C", repo, "rev-parse", "--verify", created.lease.branch], { encoding: "utf8" }).trim()).toBeTruthy();
  });

  it("is idempotent: cleaning an absent lease is a no-op", () => {
    const repo = tmp();
    initRepo(repo);
    const res = cleanWorktreeLease({ repo, taskIdentity: "never", agentIdentity: "made", worktreeRoot: tmp() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cleaned).toBe(false);
  });

  it("refuses a non-repository and an ambiguous identity", () => {
    const nonRepo = cleanWorktreeLease({ repo: tmp(), taskIdentity: "t", agentIdentity: "a", worktreeRoot: tmp() });
    expect(nonRepo.ok).toBe(false);
    if (nonRepo.ok) return;
    expect(nonRepo.reason).toBe("non_repository");

    const repo = tmp();
    initRepo(repo);
    const ambiguous = cleanWorktreeLease({ repo, taskIdentity: "", agentIdentity: "a", worktreeRoot: tmp() });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.reason).toBe("ambiguous");
  });
});

describe("redaction and formatting", () => {
  it("never leaks a secret in lease evidence or formatted output", () => {
    const repo = tmp();
    initRepo(repo);
    const root = tmp();
    const res = createWorktreeLease({
      repo,
      taskIdentity: `task ${SECRET}`,
      agentIdentity: `agent ${SECRET}`,
      worktreeRoot: root,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const blob = JSON.stringify(res) + formatWorktreeLeaseResult(res, "create");
    expect(blob).not.toContain(SECRET);
    expect(blob).toContain("[REDACTED]");
  });

  it("renders created and refused results", () => {
    const repo = tmp();
    initRepo(repo);
    const created = createWorktreeLease({ repo, taskIdentity: "task-A", agentIdentity: "agent-1", worktreeRoot: tmp() });
    expect(formatWorktreeLeaseResult(created, "create")).toContain("status:   created");

    const refused = createWorktreeLease({ repo: tmp(), taskIdentity: "t", agentIdentity: "a", worktreeRoot: tmp() });
    const text = formatWorktreeLeaseResult(refused, "create");
    expect(text).toContain("result:   refused");
    expect(text).toContain("reason:   non_repository");
  });
});
