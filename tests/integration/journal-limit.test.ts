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

describe("Integration: journal limit (--limit, Issue #636)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-636i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-636i-ws-"));
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
    store.append(sessionId, { role: "user", content: "limit fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  it("bounds both surfaces to the newest N with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--limit", "2"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("2 event(s). (+4 older event(s) not shown)");

    const json = await runCli(
      ["--session-journal", sessionId, "--limit", "2", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(2);
    expect(record.elided).toBe(4);
    // Newest two: the last note, then last-activity (live transcript mtime).
    expect(record.entries[0].kind).toBe("note");
    expect(record.entries[0].detail).toContain("crumb 3");
    expect(record.entries[1].kind).toBe("last-activity");

    // The workspace journal honors the same limit.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--limit", "2", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBe(2);
    expect(wsRecord.elided).toBe(4);

    // A limit wider than the entry count keeps everything.
    const wide = await runCli(
      ["--session-journal", sessionId, "--limit", "100", "--output", "json"],
      baseEnv,
    );
    expect(wide.code).toBe(0);
    const wideRecord = JSON.parse(wide.stdout.trim());
    expect(wideRecord.elided).toBe(0);
    expect(wideRecord.entries.length).toBe(6);

    // The limit composes with the kind filter (limit applies last).
    const composed = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--limit", "1", "--output", "json"],
      baseEnv,
    );
    expect(composed.code).toBe(0);
    const composedRecord = JSON.parse(composed.stdout.trim());
    expect(composedRecord.entries.length).toBe(1);
    expect(composedRecord.entries[0].kind).toBe("note");
    expect(composedRecord.entries[0].detail).toContain("crumb 3");
    expect(composedRecord.elided).toBe(3);
  });

  it("leaves unfiltered output unchanged (elided 0)", async () => {
    const unfiltered = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    expect(unfiltered.code).toBe(0);
    const record = JSON.parse(unfiltered.stdout.trim());
    expect(record.elided).toBe(0);
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("note");
    expect(kinds).toContain("last-activity");
    expect(record.entries.length).toBe(6);
  });

  it("fails closed on zero, negative, and non-integer limits", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await runCli(["--session-journal", sessionId, "--limit", bad], baseEnv);
      expect(res.code, `limit=${bad} stderr: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("invalid --limit value");
      expect(res.stdout).toBe("");
    }
    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--limit", "0"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("invalid --limit value");
  });

  it("still renders the honest empty state for a filter matching nothing", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--kind", "archived", "--limit", "2"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No journal entries.");
  });
});
