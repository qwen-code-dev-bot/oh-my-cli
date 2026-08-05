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

describe("Integration: storage report budget gate (--strict --storage-budget, Issue #692)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-692i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seededSession(): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "footprint fodder" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now(),
    });
    return id;
  }

  async function totalBytes(): Promise<number> {
    const res = await runCli(["--storage-report", "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    return JSON.parse(res.stdout).totalBytes as number;
  }

  it("exits 0 under budget with and without --strict, output identical", async () => {
    seededSession();
    const total = await totalBytes();
    const plain = await runCli(["--storage-report"], baseEnv);
    expect(plain.code).toBe(0);

    const strict = await runCli(
      ["--storage-report", "--strict", "--storage-budget", String(total * 2)],
      baseEnv,
    );
    expect(strict.code).toBe(0);
    expect(strict.stdout).toBe(plain.stdout);
  });

  it("exits 1 over budget, 0 without --strict, output identical", async () => {
    seededSession();
    const total = await totalBytes();
    const strict = await runCli(
      ["--storage-report", "--strict", "--storage-budget", String(total - 1)],
      baseEnv,
    );
    expect(strict.code).toBe(1);

    const plain = await runCli(["--storage-report"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
  });

  it("exits 0 exactly at budget", async () => {
    seededSession();
    const total = await totalBytes();
    const res = await runCli(
      ["--storage-report", "--strict", "--storage-budget", String(total)],
      baseEnv,
    );
    expect(res.code).toBe(0);
  });

  it("exits 0 on an empty store even under --strict --storage-budget 0", async () => {
    const res = await runCli(
      ["--storage-report", "--strict", "--storage-budget", "0"],
      baseEnv,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("0 session(s), 0B total.");
  });

  it("exits 2 with --strict but no --storage-budget, before any output", async () => {
    seededSession();
    const res = await runCli(["--storage-report", "--strict"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--strict on --storage-report requires --storage-budget");
    expect(res.stdout).toBe("");
  });

  it("exits 2 with --storage-budget but no --strict, before any output", async () => {
    seededSession();
    const res = await runCli(["--storage-report", "--storage-budget", "100"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--storage-budget is only used with --strict");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on invalid budget values", async () => {
    seededSession();
    for (const bad of ["10.5", "-1", "abc"]) {
      const res = await runCli(
        ["--storage-report", "--strict", "--storage-budget", bad],
        baseEnv,
      );
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("invalid --storage-budget value");
      expect(res.stdout).toBe("");
    }
  });

  it("keeps --output json identical with and without the gate", async () => {
    seededSession();
    const total = await totalBytes();
    const plain = await runCli(["--storage-report", "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const strict = await runCli(
      ["--storage-report", "--strict", "--storage-budget", String(total - 1), "--output", "json"],
      baseEnv,
    );
    expect(strict.code).toBe(1);
    expect(strict.stdout).toBe(plain.stdout);
  });

  it("keeps the store byte-identical through strict runs", async () => {
    seededSession();
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(
      ["--storage-report", "--strict", "--storage-budget", "0"],
      baseEnv,
    );
    expect(res.code).toBe(1);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
