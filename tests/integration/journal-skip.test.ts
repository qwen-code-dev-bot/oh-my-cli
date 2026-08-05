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

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z

describe("Integration: journal skip (--skip, Issue #638)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-638i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-638i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    sessionId = store.newId();
    store.writeMeta(sessionId, { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT });
    store.append(sessionId, { role: "user", content: "skip fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  it("pages backward with text/JSON agreement on both surfaces", async () => {
    // Fixture: created, 4 notes, last-activity (live mtime) = 6 entries.
    const text = await runCli(["--session-journal", sessionId, "--skip", "2"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("4 event(s). (+2 newer event(s) skipped)");
    expect(text.stdout).not.toContain("crumb 3");
    expect(text.stdout).not.toContain("last-activity");

    const json = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(4);
    expect(record.skipped).toBe(2);
    expect(record.elided).toBe(0);
    expect(record.entries[3].detail).toContain("crumb 2");

    // Disjoint pages cover the whole history: page 0 (newest 2), page 1
    // (skip 2, take 2), page 2 (skip 4, take 2).
    const page0 = await runCli(["--session-journal", sessionId, "--limit", "2", "--output", "json"], baseEnv);
    const page1 = await runCli(["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--output", "json"], baseEnv);
    const page2 = await runCli(["--session-journal", sessionId, "--skip", "4", "--limit", "2", "--output", "json"], baseEnv);
    const p0 = JSON.parse(page0.stdout.trim());
    const p1 = JSON.parse(page1.stdout.trim());
    const p2 = JSON.parse(page2.stdout.trim());
    expect(p0.entries.map((e: { at: number }) => e.at)).toEqual([
      CREATED_AT + 4000, // crumb 3
      p0.entries[1].at, // live last-activity
    ]);
    expect(p1.entries.map((e: { kind: string; detail: string }) => e.detail)).toEqual([
      "note added · crumb 1",
      "note added · crumb 2",
    ]);
    expect(p1.skipped).toBe(2);
    expect(p1.elided).toBe(2);
    expect(p2.entries.map((e: { detail: string }) => e.detail)).toEqual([
      "session created",
      "note added · crumb 0",
    ]);
    expect(p2.skipped).toBe(4);
    expect(p2.elided).toBe(0);

    // The workspace journal honors the same skip.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "2", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBe(4);
    expect(wsRecord.skipped).toBe(2);
  });

  it("renders the honest empty state with a truthful skipped note on over-skip", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--skip", "100"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No journal entries.");
    expect(empty.stdout).toContain("(+6 newer event(s) skipped.)");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "100"],
      baseEnv,
    );
    expect(emptyWs.code).toBe(0);
    expect(emptyWs.stdout).toContain("No journal entries for this workspace.");
    expect(emptyWs.stdout).toContain("(+6 newer event(s) skipped.)");
  });

  it("leaves unfiltered output unchanged (skipped 0)", async () => {
    const unfiltered = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    expect(unfiltered.code).toBe(0);
    const record = JSON.parse(unfiltered.stdout.trim());
    expect(record.skipped).toBe(0);
    expect(record.entries.length).toBe(6);
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("note");
    expect(kinds).toContain("last-activity");
  });

  it("fails closed on zero, negative, and non-integer skips", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await runCli(["--session-journal", sessionId, "--skip", bad], baseEnv);
      expect(res.code, `skip=${bad} stderr: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("invalid --skip value");
      expect(res.stdout).toBe("");
    }
    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "0"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("invalid --skip value");
  });
});
