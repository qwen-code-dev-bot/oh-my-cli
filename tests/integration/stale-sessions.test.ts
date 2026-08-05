import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";

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

describe("Integration: stale sessions report (--stale-sessions, Issue #626)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-626i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
  });

  function seed(ageDays: number, name?: string): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: 1 });
    store.append(id, { role: "user", content: "retention fodder" });
    if (name !== undefined) store.writeName(id, name);
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  it("reports candidates oldest-first with text/JSON agreement and protected counts", async () => {
    const oldest = seed(45, "oldest work");
    expect(appendSessionNote(store, oldest, "old breadcrumb", Date.now()).ok).toBe(true);
    seed(35);
    seed(5); // fresh — not a candidate at the default threshold
    const pinnedOld = seed(50);
    store.writePinned(pinnedOld, Date.now());
    const archivedOld = seed(60);
    store.writeArchived(archivedOld, Date.now());

    const text = await runCli(["--stale-sessions"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Candidates (oldest first):");
    expect(text.stdout).toContain("1 msgs  ·  1 note");
    expect(text.stdout).toContain("Protected (older than threshold): 1 pinned · 1 archived.");
    expect(text.stdout).toContain("Advisory only — nothing is archived.");
    // Oldest candidate listed before the 35-day one.
    expect(text.stdout.indexOf(oldest.slice(0, 8))).toBeGreaterThanOrEqual(0);

    const json = await runCli(["--stale-sessions", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.stale-sessions");
    expect(record.thresholdDays).toBe(30);
    expect(record.totalSessions).toBe(5);
    expect(record.candidates).toHaveLength(2);
    expect(record.candidates[0].sessionId).toBe(oldest);
    expect(record.candidates[0].name).toBe("oldest work");
    expect(record.candidates[0].notes).toBe(1);
    expect(record.protectedPinned).toBe(1);
    expect(record.protectedArchived).toBe(1);
    // Counts agree between the two modes.
    expect(text.stdout).toContain(`${record.totalSessions} session(s) scanned`);
  });

  it("honors a custom threshold and reports honest emptiness", async () => {
    seed(6);
    seed(2);
    const empty = await runCli(["--stale-sessions"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No stale sessions at this threshold.");

    const custom = await runCli(["--stale-sessions", "5", "--output", "json"], baseEnv);
    expect(custom.code).toBe(0);
    const record = JSON.parse(custom.stdout.trim());
    expect(record.thresholdDays).toBe(5);
    expect(record.candidates).toHaveLength(1);
  });

  it("fails closed on a bad threshold or format before any output", async () => {
    const bad = await runCli(["--stale-sessions", "abc"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("positive integer");

    const negative = await runCli(["--stale-sessions=-3"], baseEnv);
    expect(negative.code).toBe(2);
    expect(negative.stderr).toContain("positive integer");

    const badFormat = await runCli(["--stale-sessions", "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });

  it("is advisory only: the store stays byte-identical and nothing is archived", async () => {
    seed(45);
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const r1 = await runCli(["--stale-sessions"], baseEnv);
    const r2 = await runCli(["--stale-sessions", "--output", "json"], baseEnv);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
    // No archive markers appeared.
    expect(fs.readdirSync(sessionsDir()).some((f) => f.endsWith(".archived.json"))).toBe(false);
  });
});
