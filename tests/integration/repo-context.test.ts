import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rc-cli-"));
  dirs.push(d);
  return d;
}

function write(dir: string, rel: string, content = ""): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Integration: repository context (--repo-context)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and renders a human snapshot for a populated repo", async () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
    write(dir, "package-lock.json", "{}");
    initRepo(dir);
    const r = await runCli(["--repo-context", "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Repository context (oh-my-cli.repo-context v1)");
    expect(r.stdout).toContain("Toolchains : npm (package.json, package-lock.json)");
    expect(r.stdout).toContain("[package.json] tsc");
    expect(r.stdout).toContain("VCS        : on");
  });

  it("emits stable JSON with the repo-context schema", async () => {
    const dir = tmp();
    write(dir, "src/index.ts", "");
    write(dir, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }));
    write(dir, "package-lock.json", "{}");
    initRepo(dir);
    const r = await runCli(["--repo-context", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.stdout.trim());
    expect(snap.schema).toBe("oh-my-cli.repo-context");
    expect(snap.v).toBe(1);
    expect(snap.toolchains).toContainEqual({ manager: "npm", manifest: "package.json", lockfile: "package-lock.json" });
    expect(snap.commands.build).toEqual({ source: "package.json", command: "tsc" });
    expect(snap.commands.lint).toEqual({ source: "package.json", command: "eslint ." });
    expect(snap.vcs.repo).toBe(true);
    expect(Array.isArray(snap.languages)).toBe(true);
    expect(Array.isArray(snap.structure)).toBe(true);
  });

  it("dogfoods against this repository (npm + tsc/vitest, TypeScript)", async () => {
    const r = await runCli(["--repo-context", "--workspace", REPO_ROOT, "--output", "json"]);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.stdout.trim());
    expect(snap.toolchains.some((t: { manager: string }) => t.manager === "npm")).toBe(true);
    expect(snap.commands.test?.source).toBe("package.json");
    expect(snap.commands.test?.command).toContain("vitest");
    expect(snap.languages.some((l: { language: string }) => l.language === "TypeScript")).toBe(true);
    expect(snap.vcs.repo).toBe(true);
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const dir = tmp();
    write(dir, "package.json", JSON.stringify({ scripts: { test: `run --token ${SECRET}` } }));
    write(dir, "src/index.ts", "");
    initRepo(dir);
    const text = await runCli(["--repo-context", "--workspace", dir]);
    const json = await runCli(["--repo-context", "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(dir);
  });

  it("handles an empty, non-repo directory gracefully (exit 0)", async () => {
    const dir = tmp();
    const r = await runCli(["--repo-context", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const snap = JSON.parse(r.stdout.trim());
    expect(snap.toolchains).toEqual([]);
    expect(snap.commands).toEqual({ build: null, test: null, typecheck: null, lint: null });
    expect(snap.vcs.repo).toBe(false);
  });

  it("rejects an invalid --output format", async () => {
    const r = await runCli(["--repo-context", "--workspace", tmp(), "--output", "yaml"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
