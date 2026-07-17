import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
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

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cih-cli-"));
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

// A repo whose package.json declares fast canonical commands so the verify step
// (build/test) runs in milliseconds.
function initRepoWithCommands(dir: string, scripts = { build: "true", test: "true" }): void {
  write(dir, "package.json", JSON.stringify({ name: "x", scripts }));
  write(dir, "src/foo.ts", "export const x = 1;\n");
  initRepo(dir);
}

const SECRET = "ghp_" + "a".repeat(36);

describe("Integration: CI handoff (--ci-handoff)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and renders a ready-for-ci brief for a clean change", async () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = await runCli(["--ci-handoff", "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CI handoff (oh-my-cli.ci-handoff v1)");
    expect(r.stdout).toContain("Verdict: ready-for-ci");
    expect(r.stdout).toContain("Commands for CI:");
  });

  it("emits stable JSON with the ci-handoff schema", async () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = await runCli(["--ci-handoff", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.schema).toBe("oh-my-cli.ci-handoff");
    expect(report.v).toBe(1);
    expect(report.head).toMatch(/^[0-9a-f]{40}$/);
    expect(report.verdict).toBe("ready-for-ci");
    expect(report).toHaveProperty("changeSummary");
    expect(report).toHaveProperty("commands");
    expect(report).toHaveProperty("review");
    expect(report).toHaveProperty("blockers");
    expect(Array.isArray(report.commands)).toBe(true);
  });

  it("exits 1 when an introduced secret is a local blocker", async () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n`);
    const r = await runCli(["--ci-handoff", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("local-blockers");
    expect(report.review.secretsIntroduced).toBeGreaterThan(0);
    expect(report.blockers.length).toBeGreaterThan(0);
  });

  it("exits 1 when local verification fails", async () => {
    const dir = tmp();
    initRepoWithCommands(dir, { build: "true", test: "false" });
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = await runCli(["--ci-handoff", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("local-blockers");
    expect(report.blockers.some((b: string) => /verification failed/.test(b))).toBe(true);
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    write(dir, "src/leak.ts", `export const t = "${SECRET}";\n${dir}/src/secret.ts\n`);
    const text = await runCli(["--ci-handoff", "--workspace", dir]);
    const json = await runCli(["--ci-handoff", "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(dir);
  });

  it("reports no-change with exit 0 for a clean repository", async () => {
    const dir = tmp();
    initRepoWithCommands(dir);
    const r = await runCli(["--ci-handoff", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("no-change");
    expect(report.changeSummary.filesChanged).toBe(0);
  });

  it("rejects an invalid --output format (exit 2)", async () => {
    const r = await runCli(["--ci-handoff", "--workspace", tmp(), "--output", "yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
