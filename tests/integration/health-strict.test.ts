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

const META = JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 42 });

describe("Integration: health report strict exit (--strict, Issue #678)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-678i-home-"));
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
    const plain = await runCli(["--health-report"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("1 session(s): 1 ok, 0 partial, 0 corrupt.");

    const strict = await runCli(["--health-report", "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(strict.stdout).toBe(plain.stdout);
  });

  it("exits 1 under --strict for each damage class, 0 without, output identical", async () => {
    // Corrupt transcript (mid-file tear).
    const corrupt = "corrupt-src";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corrupt}.jsonl`),
      [META, "{bad middle", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    let strict = await runCli(["--health-report", "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("0 ok, 0 partial, 1 corrupt.");
    let plain = await runCli(["--health-report"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());

    // Damaged sidecar with an intact transcript.
    const sidecarDamaged = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${sidecarDamaged}.goal.json`), "{torn goal");
    strict = await runCli(["--health-report", "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("damaged sidecars: goal");
    expect(strict.stdout).toContain("1 session(s) with damaged sidecar file(s).");
    plain = await runCli(["--health-report"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());

    // Both damage classes together still exit 1 and list both findings.
    const both = "both-src";
    fs.writeFileSync(
      path.join(sessionsDir(), `${both}.jsonl`),
      [META, "{bad middle", JSON.stringify({ role: "user", content: "x" })].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(sessionsDir(), `${both}.notes.json`), "{torn notes");
    strict = await runCli(["--health-report", "--strict"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("1 corrupt");
    expect(strict.stdout).toContain("damaged sidecars: notes");
  });

  it("exits 0 under --strict for a partial-only store", async () => {
    // A single trailing tear is recoverable: partial, never failing.
    const partial = "partial-src";
    fs.writeFileSync(
      path.join(sessionsDir(), `${partial}.jsonl`),
      META + "\n" + JSON.stringify({ role: "user", content: "kept" }) + "\n" + "{torn tail\n",
    );
    const strict = await runCli(["--health-report", "--strict"], baseEnv);
    expect(strict.code).toBe(0);
    expect(strict.stdout).toContain("0 ok, 1 partial, 0 corrupt.");
    const plain = await runCli(["--health-report"], baseEnv);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(strict.stdout);
  });

  it("exits 2 on a bad output format even with --strict", async () => {
    healthySession();
    const bad = await runCli(["--health-report", "--strict", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("exits 0 on an empty store even under --strict", async () => {
    const res = await runCli(["--health-report", "--strict"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("0 session(s): 0 ok, 0 partial, 0 corrupt.");
  });

  it("keeps --output json identical with and without --strict", async () => {
    const id = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${id}.pinned.json`), "{torn pinned");
    const plain = await runCli(["--health-report", "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const strict = await runCli(["--health-report", "--strict", "--output", "json"], baseEnv);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toBe(plain.stdout);
    expect(JSON.parse(strict.stdout).sessionsWithDamagedSidecars).toBe(1);
  });

  it("keeps the store byte-identical through strict runs", async () => {
    const id = healthySession();
    fs.writeFileSync(path.join(sessionsDir(), `${id}.goal.json`), "{torn goal");
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--health-report", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
