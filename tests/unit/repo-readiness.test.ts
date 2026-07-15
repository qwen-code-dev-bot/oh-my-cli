import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkWorktree,
  checkBranch,
  checkTestCommand,
  checkExecutables,
  checkRemote,
  collectRepoReadiness,
  formatRepoReadiness,
  READINESS_SCHEMA,
  READINESS_VERSION,
} from "../../src/repo-readiness.js";

// Throwaway directories under the OS temp dir, removed after each test.
const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string, withTest = true): void {
  fs.mkdirSync(dir, { recursive: true });
  if (withTest) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
  }
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

function bareRemote(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare"]);
  return dir;
}

// A clean repo on a branch, with a test script and a reachable local remote.
function healthyRepo(): string {
  const repo = tmp();
  initRepo(repo, true);
  const remote = bareRemote(tmp());
  git(repo, ["remote", "add", "origin", remote]);
  return repo;
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("pure checks", () => {
  it("checkWorktree: clean passes, dirty fails with a count, non-repo fails clearly", () => {
    expect(checkWorktree({ repo: true, dirtyCount: 0 }).status).toBe("pass");
    const dirty = checkWorktree({ repo: true, dirtyCount: 3 });
    expect(dirty.status).toBe("fail");
    expect(dirty.detail).toBe("3 uncommitted change(s)");
    expect(dirty.nextAction).toMatch(/Commit or stash/);
    expect(checkWorktree({ repo: false, dirtyCount: 0 }).detail).toBe("not a git repository");
  });

  it("checkBranch: branch passes, detached and wrong-branch fail", () => {
    expect(checkBranch({ repo: true, branch: "main" }).status).toBe("pass");
    expect(checkBranch({ repo: true, branch: "HEAD" }).detail).toBe("detached HEAD");
    const wrong = checkBranch({ repo: true, branch: "feature", expected: "main" });
    expect(wrong.status).toBe("fail");
    expect(wrong.detail).toContain('on "feature"');
    expect(wrong.detail).toContain('expected "main"');
    expect(checkBranch({ repo: false, branch: null }).detail).toBe("not a git repository");
  });

  it("checkTestCommand: present passes with the command, missing fails with a reason", () => {
    const ok = checkTestCommand({ hasCommand: true, command: "vitest run" });
    expect(ok.status).toBe("pass");
    expect(ok.detail).toBe("vitest run");
    const bad = checkTestCommand({ hasCommand: false, reason: "package.json has no 'test' script" });
    expect(bad.status).toBe("fail");
    expect(bad.nextAction).toMatch(/Add a 'test' script/);
  });

  it("checkExecutables: lists only the missing tools", () => {
    expect(checkExecutables({ required: ["git"], missing: [] }).status).toBe("pass");
    const bad = checkExecutables({ required: ["git", "node"], missing: ["node"] });
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("node");
    expect(bad.nextAction).toContain("node");
  });

  it("checkRemote: reachable passes; unreachable, unconfigured, and non-repo fail", () => {
    expect(checkRemote({ repo: true, remote: "origin", configured: true, reachable: true }).status).toBe("pass");
    const down = checkRemote({ repo: true, remote: "origin", configured: true, reachable: false, reason: "timed out" });
    expect(down.status).toBe("fail");
    expect(down.detail).toContain("unreachable");
    expect(down.detail).toContain("timed out");
    expect(checkRemote({ repo: true, remote: "origin", configured: false, reachable: false }).detail).toContain(
      "not configured",
    );
    expect(checkRemote({ repo: false, remote: "origin", configured: false, reachable: false }).detail).toBe(
      "not a git repository",
    );
  });
});

describe("redaction", () => {
  it("redacts secret-shaped values in branch, command, and remote evidence", () => {
    expect(checkBranch({ repo: true, branch: `x ${SECRET}` }).detail).not.toContain(SECRET);
    expect(checkTestCommand({ hasCommand: true, command: `run --token ${SECRET}` }).detail).not.toContain(SECRET);
    expect(checkRemote({ repo: true, remote: `origin ${SECRET}`, configured: true, reachable: true }).detail).not.toContain(
      SECRET,
    );
  });
});

describe("collectRepoReadiness", () => {
  it("reports a healthy repository as ready with all checks passing", () => {
    const report = collectRepoReadiness({ workspace: healthyRepo(), remoteTimeoutMs: 3_000 });
    expect(report.schema).toBe(READINESS_SCHEMA);
    expect(report.v).toBe(READINESS_VERSION);
    expect(report.ready).toBe(true);
    expect(report.blocker).toBeNull();
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "worktree",
      "branch",
      "test-command",
      "executable",
      "remote",
    ]);
  });

  it("explains a dirty worktree as the blocker", () => {
    const repo = healthyRepo();
    fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted");
    const report = collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 });
    expect(report.ready).toBe(false);
    expect(report.blocker).toBe("worktree");
  });

  it("explains a detached HEAD as the blocker", () => {
    const repo = tmp();
    initRepo(repo, true);
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git(repo, ["checkout", "-q", sha]);
    const report = collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 });
    expect(report.blocker).toBe("branch");
    expect(report.checks.find((c) => c.id === "branch")?.detail).toBe("detached HEAD");
  });

  it("explains a wrong branch when an expected branch is given", () => {
    const repo = healthyRepo();
    const report = collectRepoReadiness({
      workspace: repo,
      expectedBranch: "release",
      remoteTimeoutMs: 3_000,
    });
    expect(report.blocker).toBe("branch");
    expect(report.checks.find((c) => c.id === "branch")?.detail).toContain('expected "release"');
  });

  it("explains a missing test command as the blocker", () => {
    const repo = tmp();
    initRepo(repo, false); // no package.json
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);
    const report = collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 });
    expect(report.blocker).toBe("test-command");
  });

  it("explains an unavailable required executable as the blocker", () => {
    const repo = healthyRepo();
    const report = collectRepoReadiness({
      workspace: repo,
      requiredExecutables: ["git", "definitely-not-a-real-tool-xyz"],
      remoteTimeoutMs: 3_000,
    });
    expect(report.blocker).toBe("executable");
    expect(report.checks.find((c) => c.id === "executable")?.detail).toContain("definitely-not-a-real-tool-xyz");
  });

  it("explains an unreachable remote as the blocker", () => {
    const repo = tmp();
    initRepo(repo, true);
    git(repo, ["remote", "add", "origin", "/no/such/repo.git"]);
    const report = collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 });
    expect(report.blocker).toBe("remote");
    expect(report.checks.find((c) => c.id === "remote")?.detail).toContain("unreachable");
  });

  it("reports an unconfigured remote distinctly", () => {
    const repo = tmp();
    initRepo(repo, true); // no remote added
    const report = collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 });
    expect(report.checks.find((c) => c.id === "remote")?.detail).toContain("not configured");
  });

  it("flags a non-repository directory across the git-dependent checks", () => {
    const plain = tmp();
    fs.writeFileSync(path.join(plain, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
    const report = collectRepoReadiness({ workspace: plain, remoteTimeoutMs: 3_000 });
    expect(report.ready).toBe(false);
    expect(report.blocker).toBe("worktree");
    for (const id of ["worktree", "branch", "remote"]) {
      expect(report.checks.find((c) => c.id === id)?.detail).toBe("not a git repository");
    }
    // The non-git checks still evaluate.
    expect(report.checks.find((c) => c.id === "test-command")?.status).toBe("pass");
  });

  it("is deterministic and never leaks the workspace path or secrets", () => {
    const repo = tmp();
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }),
    );
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    git(repo, ["remote", "add", "origin", bareRemote(tmp())]);

    const a = JSON.stringify(collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 }));
    const b = JSON.stringify(collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 }));
    expect(a).toBe(b);
    expect(a).not.toContain(SECRET);
    expect(a).not.toContain(repo);
  });
});

describe("formatRepoReadiness", () => {
  it("renders a ready report with a no-blocker line", () => {
    const text = formatRepoReadiness(collectRepoReadiness({ workspace: healthyRepo(), remoteTimeoutMs: 3_000 }));
    expect(text).toContain("Repository readiness (oh-my-cli.readiness v1)");
    expect(text).toContain("✓");
    expect(text).toContain("Ready: no blocker detected.");
  });

  it("renders a blocked report with the next action and blocker line", () => {
    const repo = tmp();
    initRepo(repo, true);
    fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted");
    const text = formatRepoReadiness(collectRepoReadiness({ workspace: repo, remoteTimeoutMs: 3_000 }));
    expect(text).toContain("✗");
    expect(text).toContain("→");
    expect(text).toContain("Blocked by: worktree");
  });
});
