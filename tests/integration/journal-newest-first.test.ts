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

describe("Integration: journal newest-first (--newest-first, Issue #640)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-640i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-640i-ws-"));
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
    store.append(sessionId, { role: "user", content: "order fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  it("renders both surfaces newest-first with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--newest-first"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    const entryLines = text.stdout.split("\n").filter((l) => l.trim().startsWith("2"));
    expect(entryLines.length).toBe(6);
    // First rendered entry is the newest: the live last-activity marker.
    expect(entryLines[0]).toContain("last-activity");
    expect(entryLines[0]).toContain("transcript last modified");
    // Last rendered entry is the oldest: the created marker.
    expect(entryLines[entryLines.length - 1]).toContain("created");
    expect(text.stdout).toContain("6 event(s).");

    const json = await runCli(
      ["--session-journal", sessionId, "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.order).toBe("newest-first");
    expect(record.entries[0].kind).toBe("last-activity");
    expect(record.entries[record.entries.length - 1].kind).toBe("created");

    // Same page in both directions: identical kept set and counts, reversed.
    const forward = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--output", "json"],
      baseEnv,
    );
    const backward = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--newest-first", "--output", "json"],
      baseEnv,
    );
    const f = JSON.parse(forward.stdout.trim());
    const b = JSON.parse(backward.stdout.trim());
    expect(b.order).toBe("newest-first");
    expect(f.order).toBe("oldest-first");
    expect(b.elided).toBe(f.elided);
    expect(b.skipped).toBe(f.skipped);
    expect(b.entries.map((e: { detail: string }) => e.detail)).toEqual(
      [...f.entries].reverse().map((e: { detail: string }) => e.detail),
    );

    // The workspace journal honors the same direction.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.order).toBe("newest-first");
    expect(wsRecord.entries[0].kind).toBe("last-activity");
    expect(wsRecord.entries[wsRecord.entries.length - 1].kind).toBe("created");
  });

  it("leaves unflagged output oldest-first with the order field", async () => {
    const unflagged = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    expect(unflagged.code).toBe(0);
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.order).toBe("oldest-first");
    expect(record.entries[0].kind).toBe("created");
    const ats = record.entries.map((e: { at: number }) => e.at);
    expect([...ats].sort((a: number, b: number) => a - b)).toEqual(ats);
  });

  it("keeps the honest empty state under newest-first", async () => {
    const empty = await runCli(
      ["--session-journal", sessionId, "--kind", "archived", "--newest-first"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No journal entries.");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--newest-first"],
      baseEnv,
    );
    expect(emptyWs.code).toBe(0);
    expect(emptyWs.stdout).toContain("No journal entries for this workspace.");
  });
});
