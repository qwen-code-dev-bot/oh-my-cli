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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cli-"));
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

const SECRET = "ghp_" + "a".repeat(36);

describe("Integration: change review (--review-change)", () => {
  afterAll(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("exits 0 and renders a human brief for a clean change", async () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = await runCli(["--review-change", "--workspace", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Change review (oh-my-cli.change-review v1)");
    expect(r.stdout).toContain("Verdict: clean");
    expect(r.stdout).toContain("src/bar.ts");
  });

  it("emits stable JSON with the change-review schema", async () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    write(dir, "src/bar.ts", "export const y = 2;\n");
    write(dir, "tests/unit/bar.test.ts", "import { describe } from 'vitest';\n");
    git(dir, ["add", "-A"]);
    const r = await runCli(["--review-change", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.schema).toBe("oh-my-cli.change-review");
    expect(report.v).toBe(1);
    expect(report.head).toMatch(/^[0-9a-f]{40}$/);
    expect(report.verdict).toBe("clean");
    expect(report).toHaveProperty("filesChanged");
    expect(report).toHaveProperty("signals");
    expect(report.signals).toHaveProperty("secretsIntroduced");
    expect(report.signals).toHaveProperty("protectedPaths");
  });

  it("exits 1 when an objective risk signal fires (secret introduced)", async () => {
    const dir = tmp();
    write(dir, "notes.txt", "hello\n");
    initRepo(dir);
    write(dir, "notes.txt", `hello\n${SECRET}\n`);
    git(dir, ["add", "-A"]);
    const r = await runCli(["--review-change", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("needs-attention");
    expect(report.signals.secretsIntroduced).toBeGreaterThan(0);
  });

  it("never leaks secrets or the workspace path in either output mode", async () => {
    const dir = tmp();
    write(dir, "leak.txt", "start\n");
    initRepo(dir);
    write(dir, "leak.txt", `start\n${SECRET}\n${dir}/src/secret.ts\n`);
    git(dir, ["add", "-A"]);
    const text = await runCli(["--review-change", "--workspace", dir]);
    const json = await runCli(["--review-change", "--workspace", dir, "--output", "json"]);
    const combined = text.stdout + json.stdout;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain(dir);
  });

  it("reports no-change with exit 0 for a clean repository", async () => {
    const dir = tmp();
    write(dir, "src/foo.ts", "export const x = 1;\n");
    initRepo(dir);
    const r = await runCli(["--review-change", "--workspace", dir, "--output", "json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.verdict).toBe("no-change");
    expect(report.filesChanged).toBe(0);
  });

  it("rejects an invalid --output format (exit 2)", async () => {
    const r = await runCli(["--review-change", "--workspace", tmp(), "--output", "yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid output format "yaml"');
  });
});
