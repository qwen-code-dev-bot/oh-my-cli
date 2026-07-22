import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  predictMergeConflict,
  formatConflictPrediction,
  CONFLICT_PREDICTION_SCHEMA,
  CONFLICT_PREDICTION_VERSION,
} from "../../src/conflict-prediction.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

// Create a temp repo with one commit on `main` (a.txt = "base").
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-conflict-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

// A branch that edits a.txt differently from main → conflict on a.txt.
function makeConflictingBranch(repo: string): void {
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "a.txt"), "feature change\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "feature");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "main change\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "main");
}

// A branch that adds a new file → clean merge into main.
function makeCleanBranch(repo: string): void {
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "b.txt"), "new file\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-q", "-m", "feature");
  git(repo, "checkout", "-q", "main");
}

describe("predictMergeConflict", () => {
  it("reports CLEAN for a non-conflicting branch and does not mutate the repo", () => {
    const repo = makeRepo();
    makeCleanBranch(repo);
    const headBefore = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const prediction = predictMergeConflict(repo, "feature", "main");
    expect(prediction.schema).toBe(CONFLICT_PREDICTION_SCHEMA);
    expect(prediction.v).toBe(CONFLICT_PREDICTION_VERSION);
    expect(prediction.clean).toBe(true);
    expect(prediction.conflicts).toEqual([]);
    expect(prediction.truncated).toBe(0);

    // Read-only: HEAD and working tree unchanged.
    const headAfter = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.trim()).toBe("");
  });

  it("reports CONFLICT with the conflicting path for a divergent branch", () => {
    const repo = makeRepo();
    makeConflictingBranch(repo);
    const prediction = predictMergeConflict(repo, "feature", "main");
    expect(prediction.clean).toBe(false);
    expect(prediction.conflicts).toContain("a.txt");
  });

  it("fails closed on an unresolvable source revision", () => {
    const repo = makeRepo();
    expect(() => predictMergeConflict(repo, "no-such-branch", "main")).toThrow(/cannot resolve source revision/);
  });

  it("fails closed on an unresolvable target revision", () => {
    const repo = makeRepo();
    expect(() => predictMergeConflict(repo, "main", "no-such-branch")).toThrow(/cannot resolve target revision/);
  });

  it("fails closed on a dirty working tree", () => {
    const repo = makeRepo();
    makeCleanBranch(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "uncommitted\n");
    expect(() => predictMergeConflict(repo, "feature", "main")).toThrow(/working tree is dirty/);
  });

  it("fails closed when the workspace is not a git repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-conflict-norepo-"));
    tmpDirs.push(dir);
    expect(() => predictMergeConflict(dir, "feature", "main")).toThrow(/fail closed/);
  });
});

describe("formatConflictPrediction", () => {
  it("renders a clean prediction", () => {
    const text = formatConflictPrediction({
      schema: CONFLICT_PREDICTION_SCHEMA,
      v: CONFLICT_PREDICTION_VERSION,
      source: "feature",
      target: "main",
      clean: true,
      conflicts: [],
      truncated: 0,
    });
    expect(text).toContain(`Conflict prediction (${CONFLICT_PREDICTION_SCHEMA} v${CONFLICT_PREDICTION_VERSION})`);
    expect(text).toContain("source:   feature");
    expect(text).toContain("target:   main");
    expect(text).toContain("result:   CLEAN");
  });

  it("renders a conflict prediction with paths and truncation", () => {
    const text = formatConflictPrediction({
      schema: CONFLICT_PREDICTION_SCHEMA,
      v: CONFLICT_PREDICTION_VERSION,
      source: "feature",
      target: "main",
      clean: false,
      conflicts: ["a.txt", "b.txt"],
      truncated: 3,
    });
    expect(text).toContain("result:   CONFLICT");
    expect(text).toContain("conflicts: 2");
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
    expect(text).toContain("truncated: 3 more conflicting paths beyond the bound");
  });
});
