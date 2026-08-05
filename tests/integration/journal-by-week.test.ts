import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { appendSessionNote } from "../../src/session-notes.js";
import { isoWeekKey } from "../../src/session-journal.js";

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

describe("Integration: journal by-week (--by-week, Issue #658)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;
  let weekOld: string; // two weeks ago
  let weekMid: string; // three days ago
  let weekNow: string; // today

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-658i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-658i-ws-"));
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
    const d = new Date();
    const startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // Created + 2 notes two weeks ago at 01:00Z; one note three days ago;
    // live last-activity today.
    const oldAt = startOfToday - 14 * DAY + 3_600_000;
    const midAt = startOfToday - 3 * DAY + 3_600_000;
    store.writeMeta(sessionId, { model: "fake-model", workspace: wsDir, createdAt: oldAt });
    store.append(sessionId, { role: "user", content: "by-week fodder" });
    expect(appendSessionNote(store, sessionId, "crumb 0", oldAt + 120_000).ok).toBe(true);
    expect(appendSessionNote(store, sessionId, "crumb 1", oldAt + 240_000).ok).toBe(true);
    expect(appendSessionNote(store, sessionId, "crumb 2", midAt).ok).toBe(true);
    weekOld = isoWeekKey(oldAt);
    weekMid = isoWeekKey(midAt);
    weekNow = isoWeekKey(Date.now());
  });

  // Fixture: 5 entries across 3 ISO weeks — old ×3, mid ×1, live ×1.

  it("groups both surfaces by week with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--by-week"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("5 event(s) across 3 week(s).");
    expect(text.stdout).toContain(`${weekOld} ×3`);
    expect(text.stdout).toContain(`${weekMid} ×1`);
    expect(text.stdout).toContain(`${weekNow} ×1`);

    const json = await runCli(
      ["--session-journal", sessionId, "--by-week", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal-by-week");
    expect(record.count).toBe(5);
    expect(record.byWeek).toEqual([
      { week: weekOld, count: 3 },
      { week: weekMid, count: 1 },
      { week: weekNow, count: 1 },
    ]);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);

    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-week", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.schema).toBe("oh-my-cli.workspace-journal-by-week");
    expect(wsRecord.count).toBe(5);
    expect(wsRecord.byWeek[0]).toEqual({ week: weekOld, count: 3 });
    expect(wsRecord.sessionsScanned).toBe(1);
  });

  it("composes with --kind and --since", async () => {
    const kindJson = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--by-week", "--output", "json"],
      baseEnv,
    );
    const kindRecord = JSON.parse(kindJson.stdout.trim());
    expect(kindRecord.count).toBe(3);
    expect(kindRecord.byWeek).toEqual([
      { week: weekOld, count: 2 },
      { week: weekMid, count: 1 },
    ]);

    // --since 1d keeps only the live last-activity (this week's bucket).
    const sinceJson = await runCli(
      ["--session-journal", sessionId, "--since", "1d", "--by-week", "--output", "json"],
      baseEnv,
    );
    const sinceRecord = JSON.parse(sinceJson.stdout.trim());
    expect(sinceRecord.count).toBe(1);
    expect(sinceRecord.byWeek).toEqual([{ week: weekNow, count: 1 }]);
  });

  it("agrees with --count under identical flags", async () => {
    const byWeekJson = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--by-week", "--output", "json"],
      baseEnv,
    );
    const grouped = JSON.parse(byWeekJson.stdout.trim());
    const countJson = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(countJson.stdout.trim());
    expect(grouped.count).toBe(counted.count);
    expect(grouped.elided).toBe(counted.elided);
    expect(grouped.skipped).toBe(counted.skipped);
    const bucketSum = (grouped.byWeek as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(bucketSum).toBe(grouped.count);
  });

  it("reports an honest zero grouping for a matching-nothing filter", async () => {
    const empty = await runCli(
      ["--session-journal", sessionId, "--kind", "archived", "--by-week"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-week", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyWs.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.byWeek).toEqual([]);
  });

  it("leaves unflagged output unchanged (no by-week fields on the full record)", async () => {
    const unflagged = await runCli(
      ["--session-journal", sessionId, "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.byWeek).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(5);
  });
});
