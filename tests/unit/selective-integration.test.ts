import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  integrateBranch,
  formatIntegrationResult,
  SELECTIVE_INTEGRATION_SCHEMA,
  SELECTIVE_INTEGRATION_VERSION,
} from "../../src/selective-integration.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function gitOut(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

// A temp repo with one commit on `main` (a.txt = "base").
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-integrate-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

describe("integrateBranch", () => {
  it("integrates a clean branch with a non-fast-forward merge preserving commit identity", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "feature work\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "add b");
    const featureSha = gitOut(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    const mainHeadBefore = gitOut(repo, "rev-parse", "HEAD");

    const result = integrateBranch(repo, "feature");
    expect(result.schema).toBe(SELECTIVE_INTEGRATION_SCHEMA);
    expect(result.v).toBe(SELECTIVE_INTEGRATION_VERSION);
    expect(result.integrated).toBe(true);
    expect(result.source).toBe("feature");
    expect(result.target).toBe("main");
    expect(result.head).not.toBe(mainHeadBefore);
    // The preview listed the new path and the feature commit.
    expect(result.preview.changedPaths).toContain("b.txt");
    expect(result.preview.commits.map((c) => c.sha)).toContain(featureSha.slice(0, 12));
    // Non-fast-forward: HEAD is a merge commit with two parents.
    const parents = gitOut(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents.length).toBe(3); // commit + 2 parents
    // The feature commit is preserved as an ancestor of HEAD.
    git(repo, "merge-base", "--is-ancestor", featureSha, "HEAD");
    // The integrated file is present in the working tree.
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true);
  });

  it("refuses to integrate a conflicting branch (fail closed)", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "a.txt"), "feature change\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "main change\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "main");
    const headBefore = gitOut(repo, "rev-parse", "HEAD");

    expect(() => integrateBranch(repo, "feature")).toThrow(/predicted conflict/);
    // The target was not modified.
    expect(gitOut(repo, "rev-parse", "HEAD")).toBe(headBefore);
  });

  it("fails closed on a dirty working tree", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "x\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "uncommitted\n");
    expect(() => integrateBranch(repo, "feature")).toThrow(/working tree is dirty/);
  });

  it("fails closed on an unresolvable source revision", () => {
    const repo = makeRepo();
    expect(() => integrateBranch(repo, "no-such-branch")).toThrow(/cannot resolve source revision/);
  });

  it("fails closed on a detached HEAD", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "x\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "--detach", "main");
    expect(() => integrateBranch(repo, "feature")).toThrow(/detached HEAD/);
  });

  it("dry run returns a preview without merging", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "x\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "add b");
    git(repo, "checkout", "-q", "main");
    const headBefore = gitOut(repo, "rev-parse", "HEAD");

    const result = integrateBranch(repo, "feature", { dryRun: true });
    expect(result.integrated).toBe(false);
    expect(result.preview.changedPaths).toContain("b.txt");
    // No merge happened.
    expect(gitOut(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
  });

  it("reports nothing to integrate when the source is already contained", () => {
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature"); // feature at base, no new commits
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "c.txt"), "main advances\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "main advance");

    const result = integrateBranch(repo, "feature");
    expect(result.integrated).toBe(false);
    expect(result.preview.commits).toEqual([]);
  });
});

describe("formatIntegrationResult", () => {
  it("renders an integrated result with preview", () => {
    const text = formatIntegrationResult({
      schema: SELECTIVE_INTEGRATION_SCHEMA,
      v: SELECTIVE_INTEGRATION_VERSION,
      source: "feature",
      target: "main",
      integrated: true,
      head: "abc123",
      preview: {
        changedPaths: ["b.txt"],
        truncatedPaths: 0,
        commits: [{ sha: "def456", subject: "add b" }],
        truncatedCommits: 0,
      },
    });
    expect(text).toContain(`Selective integration (${SELECTIVE_INTEGRATION_SCHEMA} v${SELECTIVE_INTEGRATION_VERSION})`);
    expect(text).toContain("source:   feature");
    expect(text).toContain("target:   main");
    expect(text).toContain("result:   INTEGRATED");
    expect(text).toContain("head:     abc123");
    expect(text).toContain("b.txt");
    expect(text).toContain("def456  add b");
  });
});
