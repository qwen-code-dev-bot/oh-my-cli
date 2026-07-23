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

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

function gitOut(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

const tmpDirs: string[] = [];
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-integrate-int-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

describe("Integration: selective integration (--integrate)", () => {
  let cleanRepo: string;
  let conflictRepo: string;
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-integrate-int-home-"));
    tmpDirs.push(homeDir);
    env = { HOME: homeDir, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };

    // Clean case: feature adds a new file (no conflict), repo left on main.
    cleanRepo = makeRepo();
    git(cleanRepo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(cleanRepo, "b.txt"), "feature work\n");
    git(cleanRepo, "add", "b.txt");
    git(cleanRepo, "commit", "-q", "-m", "add b");
    git(cleanRepo, "checkout", "-q", "main");

    // Conflict case: feature and main both edit a.txt differently, repo on main.
    conflictRepo = makeRepo();
    git(conflictRepo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(conflictRepo, "a.txt"), "feature change\n");
    git(conflictRepo, "add", "a.txt");
    git(conflictRepo, "commit", "-q", "-m", "feature");
    git(conflictRepo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(conflictRepo, "a.txt"), "main change\n");
    git(conflictRepo, "add", "a.txt");
    git(conflictRepo, "commit", "-q", "-m", "main");
  });

  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("integrates a clean branch (JSON), preserving commit identity via a merge commit", async () => {
    const headBefore = gitOut(cleanRepo, "rev-parse", "HEAD");
    const r = await runCli(
      ["--integrate", "feature", "--workspace", cleanRepo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.schema).toBe("oh-my-cli.selective-integration");
    expect(result.integrated).toBe(true);
    expect(result.target).toBe("main");
    expect(result.preview.changedPaths).toContain("b.txt");

    // A merge commit was created (HEAD advanced and has two parents).
    const headAfter = gitOut(cleanRepo, "rev-parse", "HEAD");
    expect(headAfter).not.toBe(headBefore);
    const parents = gitOut(cleanRepo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents.length).toBe(3);
    expect(fs.existsSync(path.join(cleanRepo, "b.txt"))).toBe(true);
  });

  it("refuses a conflicting branch (fail closed, exit 2) without merging", async () => {
    const headBefore = gitOut(conflictRepo, "rev-parse", "HEAD");
    const r = await runCli(
      ["--integrate", "feature", "--workspace", conflictRepo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("predicted conflict");
    // The target was not modified.
    expect(gitOut(conflictRepo, "rev-parse", "HEAD")).toBe(headBefore);
  });

  it("dry run shows a preview without merging (text)", async () => {
    // Use a fresh clean repo so the merge from the first test doesn't interfere.
    const repo = makeRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "x\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "add b");
    git(repo, "checkout", "-q", "main");
    const headBefore = gitOut(repo, "rev-parse", "HEAD");

    const r = await runCli(
      ["--integrate", "feature", "--integrate-dry-run", "--workspace", repo],
      env,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Selective integration (oh-my-cli.selective-integration v1)");
    expect(r.stdout).toContain("NOT INTEGRATED");
    expect(r.stdout).toContain("b.txt");
    // No merge happened.
    expect(gitOut(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
  });

  it("exits 2 on an unresolvable source revision", async () => {
    const r = await runCli(
      ["--integrate", "no-such-branch", "--workspace", cleanRepo],
      env,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot resolve source revision");
  });
});
