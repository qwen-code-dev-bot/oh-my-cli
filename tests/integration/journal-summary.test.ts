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

describe("Integration: journal summary (--summary, Issue #644)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-644i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-644i-ws-"));
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
    store.append(sessionId, { role: "user", content: "summary fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  // Fixture: created, 4 notes, last-activity (live mtime) = 6 entries.

  it("summarizes both surfaces with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--by-kind"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout.trim()).toBe("6 event(s): created ×1, note ×4, last-activity ×1.");

    const json = await runCli(["--session-journal", sessionId, "--by-kind", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal-summary");
    expect(record.count).toBe(6);
    expect(record.byKind).toEqual({ created: 1, note: 4, "last-activity": 1 });
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);

    // The workspace surface summarizes too.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-kind", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.schema).toBe("oh-my-cli.workspace-journal-summary");
    expect(wsRecord.count).toBe(6);
    expect(wsRecord.byKind).toEqual({ created: 1, note: 4, "last-activity": 1 });
    expect(wsRecord.sessionsScanned).toBe(1);
  });

  it("composes the summary with filters and bounds identically to count/full render", async () => {
    const kindSummary = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--by-kind"],
      baseEnv,
    );
    expect(kindSummary.code).toBe(0);
    expect(kindSummary.stdout.trim()).toBe("4 event(s): note ×4.");

    const paged = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--by-kind"],
      baseEnv,
    );
    expect(paged.code).toBe(0);
    expect(paged.stdout.trim()).toBe(
      "2 event(s): note ×2. (+2 older event(s) not shown) (+2 newer event(s) skipped)",
    );

    // The tallies agree with --count and the full render under the same flags.
    const pagedJson = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--by-kind", "--output", "json"],
      baseEnv,
    );
    const summary = JSON.parse(pagedJson.stdout.trim());
    const countJson = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(countJson.stdout.trim());
    const fullJson = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--output", "json"],
      baseEnv,
    );
    const full = JSON.parse(fullJson.stdout.trim());
    expect(summary.count).toBe(counted.count);
    expect(summary.elided).toBe(counted.elided);
    expect(summary.skipped).toBe(counted.skipped);
    expect(summary.count).toBe(full.entries.length);
    const tallySum = Object.values(summary.byKind as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(tallySum).toBe(summary.count);
  });

  it("emits tallies only — no entry contents in the JSON", async () => {
    const json = await runCli(["--session-journal", sessionId, "--by-kind", "--output", "json"], baseEnv);
    expect(json.stdout).not.toContain('"entries"');
    expect(json.stdout).not.toContain('"detail"');
    expect(json.stdout).not.toContain("crumb");
    expect(json.stdout).not.toContain("order");
  });

  it("ignores --newest-first under --by-kind", async () => {
    const plain = await runCli(["--session-journal", sessionId, "--by-kind", "--output", "json"], baseEnv);
    const flipped = await runCli(
      ["--session-journal", sessionId, "--by-kind", "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(flipped.stdout).toBe(plain.stdout);
  });

  it("reports an honest zero summary for a matching-nothing filter", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--kind", "archived", "--by-kind"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-kind", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyWs.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.byKind).toEqual({});
  });

  it("leaves unflagged output unchanged (no summary fields on the full record)", async () => {
    const unflagged = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.byKind).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(6);
  });
});
