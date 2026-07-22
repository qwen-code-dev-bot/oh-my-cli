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

const tmpDirs: string[] = [];
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-conflict-int-"));
  tmpDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "ignore"] });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

describe("Integration: conflict prediction (--predict-conflict)", () => {
  let conflictRepo: string;
  let cleanRepo: string;
  let homeDir: string;
  let env: Record<string, string>;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-conflict-int-home-"));
    tmpDirs.push(homeDir);
    env = { HOME: homeDir, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "" };

    conflictRepo = makeRepo();
    git(conflictRepo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(conflictRepo, "a.txt"), "feature change\n");
    git(conflictRepo, "add", "a.txt");
    git(conflictRepo, "commit", "-q", "-m", "feature");
    git(conflictRepo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(conflictRepo, "a.txt"), "main change\n");
    git(conflictRepo, "add", "a.txt");
    git(conflictRepo, "commit", "-q", "-m", "main");

    cleanRepo = makeRepo();
    git(cleanRepo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(cleanRepo, "b.txt"), "new file\n");
    git(cleanRepo, "add", "b.txt");
    git(cleanRepo, "commit", "-q", "-m", "feature");
    git(cleanRepo, "checkout", "-q", "main");
  });

  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("predicts CONFLICT (JSON) for a divergent branch without mutating the repo", async () => {
    const headBefore = execFileSync("git", ["-C", conflictRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const r = await runCli(
      ["--predict-conflict", "feature", "--conflict-target", "main", "--workspace", conflictRepo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const prediction = JSON.parse(r.stdout);
    expect(prediction.schema).toBe("oh-my-cli.conflict-prediction");
    expect(prediction.clean).toBe(false);
    expect(prediction.conflicts).toContain("a.txt");

    // Read-only: HEAD and working tree unchanged.
    const headAfter = execFileSync("git", ["-C", conflictRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
    const status = execFileSync("git", ["-C", conflictRepo, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.trim()).toBe("");
  });

  it("predicts CLEAN (text) for a non-conflicting branch", async () => {
    const r = await runCli(
      ["--predict-conflict", "feature", "--conflict-target", "main", "--workspace", cleanRepo],
      env,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Conflict prediction (oh-my-cli.conflict-prediction v1)");
    expect(r.stdout).toContain("result:   CLEAN");
  });

  it("defaults the target to HEAD", async () => {
    const r = await runCli(
      ["--predict-conflict", "feature", "--workspace", cleanRepo, "--output", "json"],
      env,
    );
    expect(r.code).toBe(0);
    const prediction = JSON.parse(r.stdout);
    expect(prediction.target).toBe("HEAD");
    expect(prediction.clean).toBe(true);
  });

  it("exits 2 (fail closed) on an unresolvable revision", async () => {
    const r = await runCli(
      ["--predict-conflict", "no-such-branch", "--conflict-target", "main", "--workspace", conflictRepo],
      env,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot resolve source revision");
  });

  it("exits 2 on a dirty working tree", async () => {
    fs.writeFileSync(path.join(cleanRepo, "a.txt"), "uncommitted\n");
    try {
      const r = await runCli(
        ["--predict-conflict", "feature", "--conflict-target", "main", "--workspace", cleanRepo],
        env,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("working tree is dirty");
    } finally {
      // Restore the clean repo state for any later assertions.
      git(cleanRepo, "checkout", "-q", "--", "a.txt");
    }
  });
});
