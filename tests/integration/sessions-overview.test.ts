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

describe("Integration: sessions overview (--sessions-overview, Issue #604)", () => {
  let homeDir: string;
  let wsOne: string;
  let wsTwo: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function dirSnapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snap.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    return snap;
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-604i-home-"));
    wsOne = fs.mkdtempSync(path.join(os.tmpdir(), "omc-604i-ws1-"));
    wsTwo = fs.mkdtempSync(path.join(os.tmpdir(), "omc-604i-ws2-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsOne, { recursive: true, force: true });
    fs.rmSync(wsTwo, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(workspace: string | undefined): string {
    const id = store.newId();
    store.writeMeta(
      id,
      workspace === undefined
        ? { model: "fake-model", createdAt: 1 }
        : { model: "fake-model", workspace, createdAt: 1 },
    );
    store.append(id, { role: "user", content: "overview fodder" });
    return id;
  }

  it("reports exact census counts with text/JSON agreement", async () => {
    seed(wsOne);
    seed(wsOne);
    seed(wsTwo);
    seed(undefined);
    // A corrupt session with a declared workspace (damage mid-file; a trailing
    // torn line would be "partial", not corrupt).
    fs.writeFileSync(
      path.join(sessionsDir(), "corrupt-604i.jsonl"),
      `${JSON.stringify({ meta: true, model: "fake-model", workspace: wsTwo, createdAt: 1 })}\n` +
        `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );

    const text = await runCli(["--sessions-overview"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("total:      5 session(s)");
    expect(text.stdout).toContain("integrity:  4 ok · 0 partial · 1 corrupt");
    expect(text.stdout).toContain("0 archived · 0 named · 0 with goal · 0 with notes");
    expect(text.stdout).toContain("newest:");

    const json = await runCli(["--sessions-overview", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.sessions-overview");
    expect(record.totals).toEqual({ sessions: 5, ok: 4, partial: 0, corrupt: 1 });
    expect(record.metadata).toEqual({ archived: 0, named: 0, withGoal: 0, withNotes: 0 });
    // Counts agree between the two modes.
    expect(text.stdout).toContain(`${record.totals.sessions} session(s)`);
    // Workspace breakdown: wsOne 2, wsTwo 2 (healthy + corrupt both declare it).
    const byWs = new Map(record.workspaces.map((w: { workspace: string; sessions: number }) => [w.workspace, w.sessions]));
    expect(byWs.get(wsOne)).toBe(2);
    expect(byWs.get(wsTwo)).toBe(2);
    expect(record.legacyNoWorkspace).toBe(1);
    expect(record.newest).not.toBeNull();
  });

  it("counts the metadata family truthfully", async () => {
    const archived = seed(wsOne);
    const named = seed(wsOne);
    const withGoal = seed(wsTwo);
    store.writeArchived(archived, 1_786_400_000_000);
    store.writeName(named, "overview named");
    store.writeGoal(withGoal, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: 1, updatedAt: 2 },
    });

    const json = await runCli(["--sessions-overview", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.metadata).toEqual({ archived: 1, named: 1, withGoal: 1, withNotes: 0 });
    const text = await runCli(["--sessions-overview"], baseEnv);
    expect(text.stdout).toContain("1 archived · 1 named · 1 with goal · 0 with notes");
  });

  it("is strictly read-only: the store stays byte-identical", async () => {
    seed(wsOne);
    seed(wsTwo);
    const before = dirSnapshot();
    const a = await runCli(["--sessions-overview"], baseEnv);
    const b = await runCli(["--sessions-overview", "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(dirSnapshot()).toEqual(before);
    // No quarantine artifacts from reading corrupt-free or corrupt stores.
    expect(fs.readdirSync(sessionsDir()).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("renders the honest zero state and rejects bad formats", async () => {
    const empty = await runCli(["--sessions-overview"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("total:      0 session(s)");
    expect(empty.stdout).toContain("No sessions in the store.");

    const badFormat = await runCli(["--sessions-overview", "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");
  });
});
