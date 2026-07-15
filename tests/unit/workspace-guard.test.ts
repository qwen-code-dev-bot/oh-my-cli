import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  workspaceIdentity,
  evaluateWorkspaceGuard,
  SharedWorkspaceLaunchError,
} from "../../src/workspace-guard.js";

// Each test gets throwaway directories under the OS temp dir, removed after.
const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wg-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A minimal repository with one commit so worktrees can be created.
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

describe("workspaceIdentity", () => {
  it("treats a symlinked path alias as the same workspace as its target", () => {
    const base = tmp();
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);

    expect(workspaceIdentity(link).key).toBe(workspaceIdentity(real).key);
  });

  it("treats linked git worktrees as the same repository workspace", () => {
    const base = tmp();
    const repo = path.join(base, "repo");
    initRepo(repo);
    const wt = path.join(base, "wt");
    git(repo, ["worktree", "add", "-q", wt]);

    const repoId = workspaceIdentity(repo);
    const wtId = workspaceIdentity(wt);
    expect(repoId.kind).toBe("git");
    expect(wtId.kind).toBe("git");
    // Shared git common directory ⇒ same key, even though the working trees
    // are genuinely different directories.
    expect(wtId.key).toBe(repoId.key);
    expect(wtId.displayPath).not.toBe(repoId.displayPath);
  });

  it("resolves a repository subdirectory to the repository's common dir", () => {
    const repo = tmp();
    initRepo(repo);
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });

    expect(workspaceIdentity(sub).key).toBe(workspaceIdentity(repo).key);
  });

  it("treats two independent clones as different workspaces", () => {
    const a = tmp();
    initRepo(a);
    const b = tmp();
    initRepo(b);

    expect(workspaceIdentity(a).key).not.toBe(workspaceIdentity(b).key);
  });

  it("falls back to the real directory outside a repository", () => {
    const a = tmp();
    const b = tmp();
    const idA = workspaceIdentity(a);
    expect(idA.kind).toBe("plain");
    expect(idA.key).toBe(fs.realpathSync(a));
    expect(idA.key).not.toBe(workspaceIdentity(b).key);
  });
});

describe("evaluateWorkspaceGuard", () => {
  it("refuses a mutating child that shares the parent workspace with an actionable message", () => {
    const repo = tmp();
    initRepo(repo);
    const parent = workspaceIdentity(repo);

    const decision = evaluateWorkspaceGuard({
      parentIdentity: parent,
      childWorkspace: repo,
      mode: "mutating",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("shared_workspace");
      expect(decision.message).toContain("Refusing to launch a mutating delegated agent");
      // Explains the two escape hatches.
      expect(decision.message).toContain("sequentially");
      expect(decision.message).toContain("isolated workspace");
    }
  });

  it("refuses a mutating child pointed at a linked worktree of the parent repo (no worktree bypass)", () => {
    const base = tmp();
    const repo = path.join(base, "repo");
    initRepo(repo);
    const wt = path.join(base, "wt");
    git(repo, ["worktree", "add", "-q", wt]);

    const decision = evaluateWorkspaceGuard({
      parentIdentity: workspaceIdentity(repo),
      childWorkspace: wt,
      mode: "mutating",
    });
    expect(decision.allowed).toBe(false);
  });

  it("refuses a mutating child pointed at a symlink alias of the parent (no alias bypass)", () => {
    const base = tmp();
    const real = path.join(base, "real");
    initRepo(real);
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);

    const decision = evaluateWorkspaceGuard({
      parentIdentity: workspaceIdentity(real),
      childWorkspace: link,
      mode: "mutating",
    });
    expect(decision.allowed).toBe(false);
  });

  it("still refuses when the parent tree is dirty", () => {
    const repo = tmp();
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted change");

    const decision = evaluateWorkspaceGuard({
      parentIdentity: workspaceIdentity(repo),
      childWorkspace: repo,
      mode: "mutating",
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows a read-only child to run in the shared workspace", () => {
    const repo = tmp();
    initRepo(repo);

    const decision = evaluateWorkspaceGuard({
      parentIdentity: workspaceIdentity(repo),
      childWorkspace: repo,
      mode: "read-only",
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows a mutating child in a genuinely different workspace", () => {
    const a = tmp();
    initRepo(a);
    const b = tmp();
    initRepo(b);

    const decision = evaluateWorkspaceGuard({
      parentIdentity: workspaceIdentity(a),
      childWorkspace: b,
      mode: "mutating",
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("SharedWorkspaceLaunchError", () => {
  it("is an Error carrying the shared_workspace reason", () => {
    const err = new SharedWorkspaceLaunchError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SharedWorkspaceLaunchError");
    expect(err.reason).toBe("shared_workspace");
    expect(err.message).toBe("nope");
  });
});
