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

const DAY = 86_400_000;
const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });

describe("Integration: store doctor strict exit (--strict, Issue #676)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-676i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function healthySession(): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "healthy" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now(),
    });
    return id;
  }

  it("exits 0 on a healthy store with and without --strict, output identical", async () => {
    healthySession();
    const plain = await runCli(["--store-doctor"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("Verdict: healthy.");

    const strict = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(strict.stdout).toBe(plain.stdout);
  });

  it("exits 1 under --strict for each finding class, 0 without", async () => {
    // Damaged sidecar finding.
    const sidecarDamaged = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${sidecarDamaged}.goal.json`), "{torn goal");
    let res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Verdict: attention needed");
    const withoutStrict = await runCli(["--store-doctor"], baseEnv);
    expect(withoutStrict.code).toBe(0);
    expect(withoutStrict.stdout).toBe(res.stdout);
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());

    // Corrupt transcript finding.
    const corrupt = "corrupt-src";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corrupt}.jsonl`),
      [META, "{bad middle", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("corrupt transcript");
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());

    // Stale candidate finding.
    const stale = healthySession();
    const past = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(path.join(sessionsDir(), `${stale}.jsonl`), past, past);
    res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("stale session(s)");
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());

    // Combined findings list every reason and still exit 1.
    const both = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${both}.notes.json`), "{torn notes");
    const pastBoth = new Date(Date.now() - 45 * DAY);
    fs.utimesSync(path.join(sessionsDir(), `${both}.jsonl`), pastBoth, pastBoth);
    res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("damaged sidecar file(s)");
    expect(res.stdout).toContain("stale session(s)");
  });

  it("exits 2 on a bad output format even with --strict", async () => {
    healthySession();
    const bad = await runCli(["--store-doctor", "--strict", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("exits 0 on an empty store even under --strict", async () => {
    const res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Verdict: healthy.");
  });

  it("keeps the store byte-identical through strict runs", async () => {
    const id = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${id}.goal.json`), "{torn goal");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--store-doctor", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
