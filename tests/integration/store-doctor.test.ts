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

describe("Integration: store doctor (--store-doctor, Issue #670)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let healthyId: string;
  let damagedId: string;
  let staleId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-670i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    healthyId = store.newId();
    store.checkpoint(healthyId, [{ role: "user", content: "healthy" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now(),
    });
    damagedId = store.newId();
    store.checkpoint(damagedId, [{ role: "user", content: "damaged" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now(),
    });
    fs.writeFileSync(path.join(sessionsDir(), `${damagedId}.notes.json`), "{torn notes");
    staleId = store.newId();
    store.checkpoint(staleId, [{ role: "user", content: "stale" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now() - 40 * DAY,
    });
    const past = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(path.join(sessionsDir(), `${staleId}.jsonl`), past, past);
  });

  it("composes the sections with text/JSON agreement and the right verdict", async () => {
    const text = await runCli(["--store-doctor"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Store doctor");
    expect(text.stdout).toContain("Sessions: 3 total — 3 ok, 0 partial, 0 corrupt.");
    expect(text.stdout).toContain("Sidecars: 1 session(s) with damaged sidecar file(s).");
    expect(text.stdout).toContain("Stale: 1 archive candidate(s) older than 30 days");
    expect(text.stdout).toContain(
      "Verdict: attention needed — 1 session(s) with damaged sidecar file(s); 1 stale session(s) older than 30 days (archive candidates).",
    );

    const json = await runCli(["--store-doctor", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.store-doctor");
    expect(record.v).toBe(1);
    expect(record.verdict).toBe("attention-needed");
    expect(record.reasons.length).toBe(2);
    expect(record.health.sessionCount).toBe(3);
    expect(record.health.sessionsWithDamagedSidecars).toBe(1);
    expect(record.stale.candidates).toBe(1);
    expect(record.storage.sessionCount).toBe(3);
    expect(record.storage.totalBytes).toBeGreaterThan(0);
    // Consistency with the individual reports under identical state.
    const health = await runCli(["--health-report", "--output", "json"], baseEnv);
    const healthRecord = JSON.parse(health.stdout.trim());
    expect(record.health.counts).toEqual(healthRecord.counts);
    expect(record.health.sessionsWithDamagedSidecars).toBe(healthRecord.sessionsWithDamagedSidecars);
    const storage = await runCli(["--storage-report", "--output", "json"], baseEnv);
    const storageRecord = JSON.parse(storage.stdout.trim());
    expect(record.storage.totalBytes).toBe(storageRecord.totalBytes);
    expect(record.storage.sessionCount).toBe(storageRecord.sessionCount);
  });

  it("verdicts a clean store healthy with exit 0", async () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "clean" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now(),
    });
    const text = await runCli(["--store-doctor"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Verdict: healthy.");

    const json = await runCli(["--store-doctor", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.verdict).toBe("healthy");
    expect(record.reasons).toEqual([]);
  });

  it("checks up an empty store honestly as healthy", async () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    const text = await runCli(["--store-doctor"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Sessions: 0 total — 0 ok, 0 partial, 0 corrupt.");
    expect(text.stdout).toContain("Verdict: healthy.");

    const json = await runCli(["--store-doctor", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.health.sessionCount).toBe(0);
    expect(record.storage.totalBytes).toBe(0);
    expect(record.stale.candidates).toBe(0);
  });

  it("fails closed on a bad output format and never mutates the store", async () => {
    const bad = await runCli(["--store-doctor", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--store-doctor", "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
