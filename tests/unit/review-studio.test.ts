import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reviewWorktree,
  formatReview,
} from "../../src/review-studio.js";

// Temporary-repository fixture coverage for the read-only review studio
// (Issue #342): normal, conflicted, detached, untracked, and multi-worktree
// cases. Read-only guarantee verified by comparing repository state before
// and after review.

let tmpDir: string;

function git(args: string[]): string {
  return execFileSync("git", ["-C", tmpDir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  }).trim();
}

function write(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

function repoSnapshot(): string {
  // Capture the full repository state for read-only verification.
  const status = execFileSync("git", ["-C", tmpDir, "status", "--porcelain=v1"], { encoding: "utf-8" });
  const head = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const indexHash = execFileSync("git", ["-C", tmpDir, "write-tree"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return `${status}|${head}|${indexHash}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"));
  execFileSync("git", ["init", tmpDir], { stdio: "ignore" });
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"], { stdio: "ignore" });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- normal case ------------------------------------------------------------

describe("normal worktree", () => {
  it("detects branch, head, and staged/unstaged changes", () => {
    write("a.ts", "original\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    // Stage a change.
    write("a.ts", "modified\n");
    git(["add", "a.ts"]);

    // Make an unstaged change.
    write("b.ts", "new file\n");

    const result = reviewWorktree(tmpDir);

    expect(result.worktree.headState).toBe("branch");
    expect(result.worktree.branch).toBe("master");
    expect(result.worktree.headSha).toHaveLength(7);
    expect(result.worktree.conflictInProgress).toBe(false);

    const aFile = result.files.find((f) => f.path === "a.ts");
    expect(aFile).toBeDefined();
    expect(aFile!.status).toBe("staged");
    expect(aFile!.stagedHunks.length).toBeGreaterThan(0);

    const bFile = result.files.find((f) => f.path === "b.ts");
    expect(bFile).toBeDefined();
    expect(bFile!.status).toBe("untracked");
  });

  it("detects staged+unstaged changes", () => {
    write("a.ts", "v1\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    write("a.ts", "v2\n");
    git(["add", "a.ts"]);
    write("a.ts", "v3\n");

    const result = reviewWorktree(tmpDir);
    const aFile = result.files.find((f) => f.path === "a.ts");
    expect(aFile!.status).toBe("staged+unstaged");
    expect(aFile!.stagedHunks.length).toBeGreaterThan(0);
    expect(aFile!.unstagedHunks.length).toBeGreaterThan(0);
  });
});

// --- detached HEAD ----------------------------------------------------------

describe("detached HEAD", () => {
  it("detects detached head state", () => {
    write("a.ts", "content\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    const sha = git(["rev-parse", "HEAD"]);
    git(["checkout", "--detach", sha]);

    const result = reviewWorktree(tmpDir);
    expect(result.worktree.headState).toBe("detached");
    expect(result.worktree.branch).toBeNull();
  });
});

// --- untracked files --------------------------------------------------------

describe("untracked files", () => {
  it("lists untracked files with no diff", () => {
    write("a.ts", "content\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    write("new-file.ts", "untracked\n");

    const result = reviewWorktree(tmpDir);
    const newFile = result.files.find((f) => f.path === "new-file.ts");
    expect(newFile).toBeDefined();
    expect(newFile!.status).toBe("untracked");
    expect(newFile!.stagedHunks).toHaveLength(0);
    expect(newFile!.unstagedHunks).toHaveLength(0);
  });
});

// --- conflict state ---------------------------------------------------------

describe("conflict state", () => {
  it("detects conflict in progress", () => {
    write("a.ts", "base\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);

    git(["checkout", "-b", "branch-a"]);
    write("a.ts", "branch-a change\n");
    git(["add", "."]);
    git(["commit", "-m", "branch-a"]);

    git(["checkout", "master"]);
    write("a.ts", "master change\n");
    git(["add", "."]);
    git(["commit", "-m", "master-change"]);

    // Attempt merge (will conflict).
    try {
      execFileSync("git", ["-C", tmpDir, "merge", "branch-a"], { stdio: "ignore" });
    } catch {
      // Expected conflict.
    }

    const result = reviewWorktree(tmpDir);
    expect(result.worktree.conflictInProgress).toBe(true);

    const aFile = result.files.find((f) => f.path === "a.ts");
    expect(aFile).toBeDefined();
    expect(aFile!.status).toBe("conflict");
  });
});

// --- hunk parsing -----------------------------------------------------------

describe("hunk parsing", () => {
  it("parses hunks with add/remove/context lines", () => {
    write("a.ts", "line1\nline2\nline3\nline4\nline5\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    write("a.ts", "line1\nmodified\nline3\nadded\nline4\nline5\n");
    git(["add", "a.ts"]);

    const result = reviewWorktree(tmpDir);
    const aFile = result.files.find((f) => f.path === "a.ts");
    expect(aFile!.stagedHunks.length).toBeGreaterThan(0);

    const hunk = aFile!.stagedHunks[0];
    expect(hunk.header).toContain("@@");
    expect(hunk.lines.some((l) => l.type === "add")).toBe(true);
    expect(hunk.lines.some((l) => l.type === "remove")).toBe(true);
    expect(hunk.lines.some((l) => l.type === "context")).toBe(true);
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("does not mutate the repository", () => {
    write("a.ts", "original\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    write("a.ts", "modified\n");
    write("new.ts", "untracked\n");

    const before = repoSnapshot();
    reviewWorktree(tmpDir);
    const after = repoSnapshot();

    expect(after).toBe(before);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatReview", () => {
  it("renders worktree state, files, and hunks", () => {
    write("a.ts", "content\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    write("a.ts", "changed\n");
    git(["add", "a.ts"]);

    const result = reviewWorktree(tmpDir);
    const output = formatReview(result);

    expect(output).toContain("Review Studio");
    expect(output).toContain("master");
    expect(output).toContain("a.ts");
    expect(output).toContain("staged");
    expect(output).toContain("Read-only");
  });

  it("shows detached head", () => {
    write("a.ts", "x\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    const sha = git(["rev-parse", "HEAD"]);
    git(["checkout", "--detach", sha]);

    const result = reviewWorktree(tmpDir);
    const output = formatReview(result);
    expect(output).toContain("DETACHED");
  });

  it("shows conflict warning", () => {
    write("a.ts", "base\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    git(["checkout", "-b", "br"]);
    write("a.ts", "br\n");
    git(["add", "."]);
    git(["commit", "-m", "br"]);
    git(["checkout", "master"]);
    write("a.ts", "master\n");
    git(["add", "."]);
    git(["commit", "-m", "m"]);
    try { execFileSync("git", ["-C", tmpDir, "merge", "br"], { stdio: "ignore" }); } catch { /* conflict */ }

    const result = reviewWorktree(tmpDir);
    const output = formatReview(result);
    expect(output).toContain("CONFLICT");
  });
});

// --- multi-worktree ---------------------------------------------------------

describe("multi-worktree", () => {
  it("reviews a linked worktree independently", () => {
    write("a.ts", "main content\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);

    // Create a linked worktree.
    const wtPath = path.join(tmpDir, "..", "linked-wt");
    git(["worktree", "add", wtPath, "-b", "feature"]);
    fs.writeFileSync(path.join(wtPath, "feature.ts"), "feature code\n");

    const result = reviewWorktree(wtPath);
    expect(result.worktree.branch).toBe("feature");
    const featureFile = result.files.find((f) => f.path === "feature.ts");
    expect(featureFile).toBeDefined();
    expect(featureFile!.status).toBe("untracked");

    // Cleanup linked worktree.
    fs.rmSync(wtPath, { recursive: true, force: true });
  });
});
