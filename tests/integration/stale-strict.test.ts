import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

const DAY = 24 * 60 * 60 * 1000;

// ageMs is measured at read instant, so two runs a moment apart differ only
// there; strip it (existing convention) before comparing JSON records.
function stripAgeMs(s: string): unknown {
  return JSON.parse(s, (k, v) => (k === "ageMs" ? undefined : v));
}

describe("Integration: stale sessions strict exit (--strict, Issue #680)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-680i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(ageDays: number): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: 1 });
    store.append(id, { role: "user", content: "retention fodder" });
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  it("exits 0 on a fresh store with and without --strict, output identical", async () => {
    seed(5);
    const plain = await runCli(["--stale-sessions"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("No stale sessions at this threshold.");

    const strict = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(strict.stdout).toBe(plain.stdout);
  });

  it("exits 1 under --strict when candidates exist, 0 without, output identical", async () => {
    seed(45);
    seed(35);
    seed(5);
    const strict = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("Candidates (oldest first):");

    const plain = await runCli(["--stale-sessions"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
  });

  it("exits 0 under --strict when old sessions are pinned", async () => {
    const id = seed(50);
    store.writePinned(id, Date.now());
    const res = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Protected (older than threshold): 1 pinned · 0 archived.");
    expect(res.stdout).toContain("No stale sessions at this threshold.");
  });

  it("exits 0 under --strict when old sessions are archived", async () => {
    const id = seed(60);
    store.writeArchived(id, Date.now());
    const res = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Protected (older than threshold): 0 pinned · 1 archived.");
  });

  it("exits 0 on an empty store even under --strict", async () => {
    const res = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("0 session(s) scanned");
  });

  it("exits 2 on a bad output format even with --strict", async () => {
    seed(45);
    const bad = await runCli(["--stale-sessions", "--strict", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("keeps --output json identical with and without --strict", async () => {
    seed(45);
    const plain = await runCli(["--stale-sessions", "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const strict = await runCli(["--stale-sessions", "--strict", "--output", "json"], baseEnv);
    expect(strict.code).toBe(1);
    expect(stripAgeMs(strict.stdout)).toStrictEqual(stripAgeMs(plain.stdout));
    expect(JSON.parse(strict.stdout).candidates).toHaveLength(1);
  });

  it("keeps the store byte-identical through strict runs", async () => {
    seed(45);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--stale-sessions", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
