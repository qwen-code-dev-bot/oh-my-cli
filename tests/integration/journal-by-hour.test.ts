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

const DAY = 86_400_000;

describe("Integration: journal by-hour (--by-hour, Issue #656)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;
  let startOfToday: number;
  let yesterdayHour01: string;
  let yesterdayHour02: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-656i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-656i-ws-"));
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
    startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // Yesterday 01:00Z (created + 2 notes in the same hour), yesterday
    // 02:30Z (one note in the next hour), live last-activity today.
    const yesterday0100 = startOfToday - DAY + 3_600_000;
    store.writeMeta(sessionId, { model: "fake-model", workspace: wsDir, createdAt: yesterday0100 });
    store.append(sessionId, { role: "user", content: "by-hour fodder" });
    expect(appendSessionNote(store, sessionId, "crumb 0", yesterday0100 + 120_000).ok).toBe(true);
    expect(appendSessionNote(store, sessionId, "crumb 1", yesterday0100 + 240_000).ok).toBe(true);
    expect(
      appendSessionNote(store, sessionId, "crumb 2", startOfToday - DAY + 2 * 3_600_000 + 1_800_000).ok,
    ).toBe(true);
    yesterdayHour01 = new Date(yesterday0100).toISOString().slice(0, 13);
    yesterdayHour02 = new Date(startOfToday - DAY + 2 * 3_600_000).toISOString().slice(0, 13);
  });

  // Fixture: 5 entries across 3 hour buckets — T01 ×3, T02 ×1, live ×1.

  it("groups both surfaces by hour with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--by-hour"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("5 event(s) across 3 hour(s).");
    expect(text.stdout).toContain(`${yesterdayHour01} ×3`);
    expect(text.stdout).toContain(`${yesterdayHour02} ×1`);

    const json = await runCli(
      ["--session-journal", sessionId, "--by-hour", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal-by-hour");
    expect(record.count).toBe(5);
    expect(record.byHour[0]).toEqual({ hour: yesterdayHour01, count: 3 });
    expect(record.byHour[1]).toEqual({ hour: yesterdayHour02, count: 1 });
    // The live last-activity bucket lives on today's date.
    const todayPrefix = new Date(startOfToday).toISOString().slice(0, 10);
    expect(record.byHour[2].hour.startsWith(todayPrefix)).toBe(true);
    expect(record.byHour[2].count).toBe(1);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);

    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-hour", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.schema).toBe("oh-my-cli.workspace-journal-by-hour");
    expect(wsRecord.count).toBe(5);
    expect(wsRecord.byHour[0]).toEqual({ hour: yesterdayHour01, count: 3 });
    expect(wsRecord.sessionsScanned).toBe(1);
  });

  it("composes with --kind and --since today", async () => {
    const kindJson = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--by-hour", "--output", "json"],
      baseEnv,
    );
    const kindRecord = JSON.parse(kindJson.stdout.trim());
    expect(kindRecord.count).toBe(3);
    expect(kindRecord.byHour).toEqual([
      { hour: yesterdayHour01, count: 2 },
      { hour: yesterdayHour02, count: 1 },
    ]);

    const todayJson = await runCli(
      ["--session-journal", sessionId, "--since", "today", "--by-hour", "--output", "json"],
      baseEnv,
    );
    const todayRecord = JSON.parse(todayJson.stdout.trim());
    expect(todayRecord.count).toBe(1);
    expect(todayRecord.byHour.length).toBe(1);
  });

  it("agrees with --count under identical flags", async () => {
    const byHourJson = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--by-hour", "--output", "json"],
      baseEnv,
    );
    const grouped = JSON.parse(byHourJson.stdout.trim());
    const countJson = await runCli(
      ["--session-journal", sessionId, "--skip", "1", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(countJson.stdout.trim());
    expect(grouped.count).toBe(counted.count);
    expect(grouped.elided).toBe(counted.elided);
    expect(grouped.skipped).toBe(counted.skipped);
    const bucketSum = (grouped.byHour as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(bucketSum).toBe(grouped.count);
  });

  it("reports an honest zero grouping for a matching-nothing filter", async () => {
    const empty = await runCli(
      ["--session-journal", sessionId, "--kind", "archived", "--by-hour"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-hour", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyWs.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.byHour).toEqual([]);
  });

  it("leaves unflagged output unchanged (no by-hour fields on the full record)", async () => {
    const unflagged = await runCli(
      ["--session-journal", sessionId, "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.byHour).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(5);
  });
});
