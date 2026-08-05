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

describe("Integration: sidecar health diagnostics (--health-report, Issue #668)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let healthyId: string;
  let notesDamagedId: string;
  let transcriptDamagedId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-668i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    // Fully healthy session with valid goal + notes sidecars.
    healthyId = store.newId();
    store.checkpoint(healthyId, [{ role: "user", content: "healthy" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1,
    });
    store.writeGoal(healthyId, {
      revision: 1,
      goal: { objective: "healthy goal", status: "active", createdAt: 1, updatedAt: 1 },
      history: [{ revision: 1, kind: "set", objective: "healthy goal", status: "active", at: 1 }],
    });
    expect(appendSessionNote(store, healthyId, "healthy note", 2).ok).toBe(true);
    // Healthy transcript, damaged notes sidecar.
    notesDamagedId = store.newId();
    store.checkpoint(notesDamagedId, [{ role: "user", content: "notes damaged" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 2,
    });
    fs.writeFileSync(
      path.join(sessionsDir(), `${notesDamagedId}.notes.json`),
      "{torn notes ledger",
    );
    // Corrupt transcript AND damaged goal sidecar.
    transcriptDamagedId = store.newId();
    fs.writeFileSync(
      path.join(sessionsDir(), `${transcriptDamagedId}.jsonl`),
      [
        JSON.stringify({ meta: true, model: "fake-model", workspace: "/srv/ws", createdAt: 3 }),
        "{bad middle",
        JSON.stringify({ role: "user", content: "x" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionsDir(), `${transcriptDamagedId}.goal.json`),
      "{torn goal",
    );
  });

  it("reports sidecar damage in text and JSON with the extended ordering", async () => {
    const text = await runCli(["--health-report"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("3 session(s): 2 ok, 0 partial, 1 corrupt.");
    expect(text.stdout).toContain("2 session(s) with damaged sidecar file(s).");
    expect(text.stdout).toContain("(damaged sidecars: notes)");
    expect(text.stdout).toContain("damaged sidecars: goal");

    const json = await runCli(["--health-report", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-health");
    expect(record.sessionCount).toBe(3);
    expect(record.sessionsWithDamagedSidecars).toBe(2);
    // Worst-first: the corrupt transcript with a damaged goal leads; the two
    // ok sessions follow — the one with the damaged notes sidecar first.
    expect(record.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      transcriptDamagedId,
      notesDamagedId,
      healthyId,
    ]);
    const byId = new Map(
      record.sessions.map((s: { sessionId: string; damagedSidecars: string[] }) => [
        s.sessionId,
        s.damagedSidecars,
      ]),
    );
    expect(byId.get(transcriptDamagedId)).toEqual(["goal"]);
    expect(byId.get(notesDamagedId)).toEqual(["notes"]);
    expect(byId.get(healthyId)).toEqual([]);
  });

  it("keeps transcript statuses, rollups, and exit semantics unchanged", async () => {
    const json = await runCli(["--health-report", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.counts).toEqual({ ok: 2, partial: 0, corrupt: 1 });
    expect(json.code).toBe(0);
  });

  it("reports an empty store honestly (no damaged-sidecar line)", async () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    const text = await runCli(["--health-report"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("0 session(s): 0 ok, 0 partial, 0 corrupt.");
    expect(text.stdout).not.toContain("damaged sidecar");

    const json = await runCli(["--health-report", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.sessionsWithDamagedSidecars).toBe(0);
    expect(record.sessions).toEqual([]);
  });

  it("fails closed on a bad output format and never mutates damaged files", async () => {
    const bad = await runCli(["--health-report", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");

    const notesBefore = fs.readFileSync(
      path.join(sessionsDir(), `${notesDamagedId}.notes.json`),
      "utf-8",
    );
    const goalBefore = fs.readFileSync(
      path.join(sessionsDir(), `${transcriptDamagedId}.goal.json`),
      "utf-8",
    );
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--health-report", "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
    expect(fs.readFileSync(path.join(sessionsDir(), `${notesDamagedId}.notes.json`), "utf-8")).toBe(notesBefore);
    expect(fs.readFileSync(path.join(sessionsDir(), `${transcriptDamagedId}.goal.json`), "utf-8")).toBe(goalBefore);
  });
});
