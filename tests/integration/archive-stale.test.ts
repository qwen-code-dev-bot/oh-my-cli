import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

const DAY = 24 * 60 * 60 * 1000;

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

describe("Integration: archive-stale executor (--archive-stale, Issue #702)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let staleId: string;
  let freshId: string;
  let pinnedId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function seedSession(ageDays: number): string {
    const id = store.newId();
    store.checkpoint(id, [{ role: "user", content: "retention fodder" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: Date.now() - (ageDays + 15) * DAY,
    });
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(store.filePath(id), t, t);
    return id;
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-702i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    staleId = seedSession(45);
    freshId = seedSession(5);
    pinnedId = seedSession(50);
    store.writePinned(pinnedId, Date.now());
  });

  it("dry run exits 0, prints the stale report plus the note, store byte-identical", async () => {
    const stale = await runCli(["--stale-sessions"], baseEnv);
    expect(stale.code).toBe(0);

    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }

    const dry = await runCli(["--archive-stale"], baseEnv);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toBe(
      stale.stdout + "\nDry run: nothing archived (re-run with --apply to archive the sessions above).\n",
    );
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });

  it("apply archives exactly the stale candidates and is idempotent", async () => {
    const apply = await runCli(["--archive-stale", "--apply"], baseEnv);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain("Archived 1 session(s). Nothing was deleted");
    expect(fs.existsSync(path.join(sessionsDir(), `${staleId}.archived.json`))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir(), `${freshId}.archived.json`))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir(), `${pinnedId}.archived.json`))).toBe(false);

    const rerun = await runCli(["--archive-stale", "--apply"], baseEnv);
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).toContain("No stale archive candidates at this threshold.");
    expect(rerun.stdout).toContain("Archived 0 session(s).");
  });

  it("keeps transcripts byte-identical through an apply run", async () => {
    const before = fs.readFileSync(path.join(sessionsDir(), `${staleId}.jsonl`), "utf-8");
    const files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl")).sort();
    const res = await runCli(["--archive-stale", "--apply"], baseEnv);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(sessionsDir(), `${staleId}.jsonl`), "utf-8")).toBe(before);
    const filesAfter = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl")).sort();
    expect(filesAfter).toEqual(files);
  });

  it("emits the versioned json record in both modes", async () => {
    const dry = await runCli(["--archive-stale", "--output", "json"], baseEnv);
    expect(dry.code).toBe(0);
    const dryRecord = JSON.parse(dry.stdout);
    expect(dryRecord.schema).toBe("oh-my-cli.archive-stale");
    expect(dryRecord.v).toBe(1);
    expect(dryRecord.mode).toBe("dry-run");
    expect(dryRecord.thresholdDays).toBe(30);
    expect(dryRecord.candidates.map((c: { sessionId: string }) => c.sessionId)).toEqual([staleId]);
    expect(dryRecord.archivedIds).toEqual([]);
    expect(dryRecord.protectedPinned).toBe(1);

    const apply = await runCli(["--archive-stale", "--apply", "--output", "json"], baseEnv);
    expect(apply.code).toBe(0);
    const applyRecord = JSON.parse(apply.stdout);
    expect(applyRecord.mode).toBe("apply");
    expect(applyRecord.candidates.map((c: { sessionId: string }) => c.sessionId)).toEqual([staleId]);
    expect(applyRecord.archivedIds).toEqual([staleId]);
  });

  it("honors a custom threshold", async () => {
    const narrow = await runCli(["--archive-stale", "40", "--output", "json"], baseEnv);
    expect(narrow.code).toBe(0);
    expect(JSON.parse(narrow.stdout).thresholdDays).toBe(40);

    const wide = await runCli(["--archive-stale", "60", "--output", "json"], baseEnv);
    expect(wide.code).toBe(0);
    expect(JSON.parse(wide.stdout).candidates).toEqual([]);
  });

  it("exits 2 on invalid days with empty stdout", async () => {
    const res = await runCli(["--archive-stale", "abc"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--archive-stale days must be a positive integer");
    expect(res.stdout).toBe("");
  });

  it("exits 2 for --apply without --archive-stale", async () => {
    const res = await runCli(["--apply"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--apply is only used with --archive-stale");
    expect(res.stdout).toBe("");
  });
});
