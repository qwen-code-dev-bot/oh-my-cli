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
  timeoutMs = 20_000,
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

describe("Integration: cross-session note search (--search-notes, Issue #606)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_500_000_000;

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
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-606i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seed(name?: string): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp", createdAt: NOW });
    store.append(id, { role: "user", content: "notes host" });
    if (name !== undefined) store.writeName(id, name);
    return id;
  }

  it("finds notes across sessions with text/JSON agreement", async () => {
    const a = seed("first ledger");
    expect(appendSessionNote(store, a, "MIGRATION decision logged", NOW).ok).toBe(true);
    expect(appendSessionNote(store, a, "unrelated breadcrumb", NOW + 1000).ok).toBe(true);
    const b = seed();
    expect(appendSessionNote(store, b, "migration follow-up pending", NOW + 2000).ok).toBe(true);

    const text = await runCli(["--search-notes", "migration"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Session notes search — \"migration\"");
    expect(text.stdout).toContain("Scanned 2 note ledger(s).");
    expect(text.stdout).toContain("MIGRATION decision logged");
    expect(text.stdout).toContain("migration follow-up pending");
    expect(text.stdout).toContain("(first ledger)");
    expect(text.stdout).toContain("2 match(es).");

    const json = await runCli(["--search-notes", "migration", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-notes-search");
    expect(record.ledgersScanned).toBe(2);
    expect(record.matches).toHaveLength(2);
    // Deterministic sorted-id iteration order (uuids are random per run).
    const ids = record.matches.map((m: { sessionId: string }) => m.sessionId);
    expect(ids).toEqual([...ids].sort());
    const bySession = new Map(
      record.matches.map((m: { sessionId: string; snippet: string; sessionName?: string; at: string }) => [
        m.sessionId,
        m,
      ]),
    );
    const matchA = bySession.get(a) as { snippet: string; sessionName?: string; at: string };
    expect(matchA.snippet).toBe("MIGRATION decision logged");
    expect(matchA.sessionName).toBe("first ledger");
    expect(matchA.at).toBe(new Date(NOW).toISOString());
    expect((bySession.get(b) as { snippet: string }).snippet).toBe("migration follow-up pending");
    expect(record.elidedPerSession).toBe(0);
    expect(record.elidedTotal).toBe(0);
  });

  it("skips archived sessions and includes corrupt sessions' notes", async () => {
    const archived = seed();
    expect(appendSessionNote(store, archived, "needle archived", NOW).ok).toBe(true);
    store.writeArchived(archived, NOW);

    const corruptId = "corrupt-606i";
    fs.writeFileSync(
      path.join(sessionsDir(), `${corruptId}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n` +
        `${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    expect(appendSessionNote(store, corruptId, "needle corrupt", NOW).ok).toBe(true);

    const json = await runCli(["--search-notes", "needle", "--output", "json"], baseEnv);
    expect(json.code, `stderr: ${json.stderr}`).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.ledgersScanned).toBe(1);
    expect(record.matches).toHaveLength(1);
    expect(record.matches[0].sessionId).toBe(corruptId);
    expect(record.matches[0].snippet).toBe("needle corrupt");
  });

  it("is strictly read-only: the store stays byte-identical across scans", async () => {
    const id = seed();
    expect(appendSessionNote(store, id, "stable breadcrumb", NOW).ok).toBe(true);
    const before = dirSnapshot();
    const a = await runCli(["--search-notes", "stable"], baseEnv);
    const b = await runCli(["--search-notes", "stable", "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(dirSnapshot()).toEqual(before);
  });

  it("fails closed on blank queries and bad formats; renders honest no-match", async () => {
    seed();
    const blank = await runCli(["--search-notes", "   "], baseEnv);
    expect(blank.code).toBe(2);
    expect(blank.stderr).toContain("non-empty");

    const badFormat = await runCli(["--search-notes", "x", "--output", "yaml"], baseEnv);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("invalid output format");

    const none = await runCli(["--search-notes", "zzz-not-present"], baseEnv);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("No matching notes found.");
  });
});
