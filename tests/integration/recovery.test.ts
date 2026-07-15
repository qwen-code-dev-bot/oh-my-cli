import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 15_000,
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

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rec-cli-"));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A committed git repo so the CLI can derive a stable HEAD; returns its sha.
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "hello");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeCheckpoint(
  file: string,
  cp: { taskIdentity: string; repoHead: string; steps: { id: string; digest: string }[] },
): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ schema: "oh-my-cli.recovery", v: 1, ...cp }, null, 2),
  );
}

function writeEvidence(file: string, evidence: Record<string, string>): void {
  fs.writeFileSync(file, JSON.stringify(evidence));
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

describe("Integration: run recovery (--recover)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("resumes (exit 0) when head, task, and evidence all match", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: head, steps: [{ id: "build", digest: digest("out") }] });
    writeEvidence(ev, { build: digest("out") });

    const r = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-A", "--evidence", ev, "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout.trim());
    expect(plan.schema).toBe("oh-my-cli.recovery");
    expect(plan.decision).toBe("resume");
    expect(plan.completed).toEqual(["build"]);
  });

  it("renders a human resume plan", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: head, steps: [{ id: "build", digest: digest("out") }] });
    writeEvidence(ev, { build: digest("out") });

    const r = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-A", "--evidence", ev, "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Run recovery (oh-my-cli.recovery v1)");
    expect(r.stdout).toContain("decision:  resume");
  });

  it("refuses (exit 1) a stale checkpoint when the repository head moved", async () => {
    const dir = tmp();
    initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: "0".repeat(40), steps: [{ id: "build", digest: digest("out") }] });
    writeEvidence(ev, { build: digest("out") });

    const r = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-A", "--evidence", ev, "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).decision).toBe("refuse");
  });

  it("refuses (exit 1) a tampered checkpoint when evidence changed", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: head, steps: [{ id: "build", digest: digest("out") }] });
    writeEvidence(ev, { build: digest("TAMPERED") });

    const r = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-A", "--evidence", ev, "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).decision).toBe("refuse");
  });

  it("refuses (exit 1) an ambiguous checkpoint when the task identity differs", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: head, steps: [{ id: "build", digest: digest("out") }] });
    writeEvidence(ev, { build: digest("out") });

    const r = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-B", "--evidence", ev, "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim()).decision).toBe("refuse");
  });

  it("never leaks secrets in either output mode", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    const ev = path.join(dir, "evidence.json");
    writeCheckpoint(cp, { taskIdentity: `task ${SECRET}`, repoHead: head, steps: [{ id: `step ${SECRET}`, digest: digest("out") }] });
    writeEvidence(ev, { [`step ${SECRET}`]: digest("out") });

    const text = await runCli(["--recover", "--checkpoint", cp, "--task-identity", `task ${SECRET}`, "--evidence", ev, "--workspace", dir]);
    const json = await runCli(["--recover", "--checkpoint", cp, "--task-identity", `task ${SECRET}`, "--evidence", ev, "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout + text.stderr + json.stderr;
    expect(combined).not.toContain(SECRET);
  });

  it("exits 2 on usage and input errors", async () => {
    const dir = tmp();
    const head = initRepo(dir);
    const cp = path.join(dir, "checkpoint.json");
    writeCheckpoint(cp, { taskIdentity: "task-A", repoHead: head, steps: [] });

    const noCheckpoint = await runCli(["--recover", "--task-identity", "task-A", "--workspace", dir]);
    expect(noCheckpoint.code).toBe(2);
    expect(noCheckpoint.stderr).toContain("--recover requires --checkpoint");

    const noTask = await runCli(["--recover", "--checkpoint", cp, "--workspace", dir]);
    expect(noTask.code).toBe(2);
    expect(noTask.stderr).toContain("--recover requires --task-identity");

    const badOutput = await runCli(["--recover", "--checkpoint", cp, "--task-identity", "task-A", "--workspace", dir, "--output", "yaml"]);
    expect(badOutput.code).toBe(2);

    const missingFile = await runCli(["--recover", "--checkpoint", path.join(dir, "nope.json"), "--task-identity", "task-A", "--workspace", dir]);
    expect(missingFile.code).toBe(2);
  });
});
