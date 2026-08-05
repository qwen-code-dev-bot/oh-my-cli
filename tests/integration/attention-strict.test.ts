import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
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

// Age labels are clock-relative ("Ns ago" under 60s), so backdate transcripts
// beyond the second bucket and normalize whatever remains before byte compare.
const BACKDATE_HOURS = 2;

function stripAgeMs(s: string): unknown {
  return JSON.parse(s, (k, v) => (k === "ageMs" ? undefined : v));
}

function normalizeAges(s: string): string {
  return s.replace(/\b\d+(s|m|h|d) ago\b/g, "<age> ago");
}

describe("Integration: attention strict exit (--strict, Issue #682)", () => {
  let homeDir: string;
  let wsA: string;
  let wsB: string;
  let baseEnv: Record<string, string>;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-682i-home-"));
    wsA = fs.mkdtempSync(path.join(os.tmpdir(), "omc-682i-wsA-"));
    wsB = fs.mkdtempSync(path.join(os.tmpdir(), "omc-682i-wsB-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
  });

  function seed(name: string, workspace: string, lines: string[]): void {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const p = path.join(sessionsDir(), `${name}.jsonl`);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    const t = new Date(Date.now() - BACKDATE_HOURS * 60 * 60 * 1000);
    fs.utimesSync(p, t, t);
  }

  const meta = (workspace: string) =>
    JSON.stringify({ meta: true, model: "fake-model", workspace, createdAt: 1 });

  // One corrupt and one completed session in wsA, one foreign session in wsB
  // that must never leak into wsA's gate.
  function seedMixed(): void {
    seed("corrupt-one", wsA, [
      meta(wsA),
      JSON.stringify({ role: "user", content: "hi" }),
      "{ this is not json }",
      JSON.stringify({ role: "assistant", content: "ok" }),
    ]);
    seed("done-one", wsA, [
      meta(wsA),
      JSON.stringify({ role: "user", content: "work" }),
      JSON.stringify({ role: "assistant", content: "MAIN ANSWER" }),
    ]);
    seed("foreign-one", wsB, [
      meta(wsB),
      JSON.stringify({ role: "user", content: "foreign" }),
      JSON.stringify({ role: "assistant", content: "answer" }),
    ]);
  }

  it("exits 1 under --strict when items exist, 0 without, output identical", async () => {
    seedMixed();
    const strict = await runCli(["--attention", "--workspace", wsA, "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("corrupt-session");
    expect(strict.stdout).not.toContain("foreign");

    const plain = await runCli(["--attention", "--workspace", wsA], baseEnv);
    expect(plain.code).toBe(0);
    expect(normalizeAges(plain.stdout)).toBe(normalizeAges(strict.stdout));
  });

  it("exits 0 under --strict for a quiet (empty) workspace", async () => {
    const res = await runCli(["--attention", "--workspace", wsA, "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Nothing needs attention in this workspace.");
  });

  it("exits 0 under --strict when only foreign-workspace sessions exist", async () => {
    seed("foreign-only", wsB, [
      meta(wsB),
      JSON.stringify({ role: "user", content: "foreign" }),
      JSON.stringify({ role: "assistant", content: "answer" }),
    ]);
    const res = await runCli(["--attention", "--workspace", wsA, "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Nothing needs attention in this workspace.");
  });

  it("exits 2 on a bad output format even with --strict", async () => {
    seedMixed();
    const bad = await runCli(
      ["--attention", "--workspace", wsA, "--strict", "--output", "yaml"],
      baseEnv,
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("keeps --output json identical with and without --strict", async () => {
    seedMixed();
    const plain = await runCli(
      ["--attention", "--workspace", wsA, "--output", "json"],
      baseEnv,
    );
    expect(plain.code).toBe(0);
    const strict = await runCli(
      ["--attention", "--workspace", wsA, "--strict", "--output", "json"],
      baseEnv,
    );
    expect(strict.code).toBe(1);
    expect(stripAgeMs(strict.stdout)).toStrictEqual(stripAgeMs(plain.stdout));
    expect(JSON.parse(strict.stdout).total).toBe(2);
  });

  it("keeps the store byte-identical through strict runs", async () => {
    seedMixed();
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--attention", "--workspace", wsA, "--strict"], baseEnv);
    expect(res.code).toBe(1);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
