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

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

describe("Integration: journal by-session-day (--by-session-day, Issue #662)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sid1: string;
  let sid2: string;
  let dayThreeAgo: string;
  let dayYesterday: string;
  let dayToday: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function shortOf(id: string): string {
    return id.split("-")[0].slice(0, 8);
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-662i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-662i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    const d = new Date();
    const startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const threeAgoAt = startOfToday - 3 * DAY + 3_600_000; // 01:00 three days ago
    const yesterdayAt = startOfToday - DAY + 3_600_000; // 01:00 yesterday
    dayThreeAgo = dayOf(threeAgoAt);
    dayYesterday = dayOf(yesterdayAt);
    dayToday = dayOf(Date.now());

    // Session 1: created + note three days ago; live last-activity today.
    sid1 = store.newId();
    store.writeMeta(sid1, { model: "fake-model", workspace: wsDir, createdAt: threeAgoAt });
    store.append(sid1, { role: "user", content: "cross-tab fodder 1" });
    expect(appendSessionNote(store, sid1, "crumb 1", threeAgoAt + 3_600_000).ok).toBe(true);

    // Session 2: created three days ago; note yesterday.
    sid2 = store.newId();
    store.writeMeta(sid2, { model: "fake-model", workspace: wsDir, createdAt: threeAgoAt + 7_200_000 });
    store.append(sid2, { role: "user", content: "cross-tab fodder 2" });
    expect(appendSessionNote(store, sid2, "crumb 2", yesterdayAt).ok).toBe(true);
  });

  // Fixture: 6 entries across 5 pairs — (day-3, s1) ×2, (day-3, s2) ×1,
  // (yesterday, s2) ×1, (today, s1) ×1 live, (today, s2) ×1 live.

  it("cross-tabs both days and sessions with text/JSON agreement", async () => {
    const expected = [
      { day: dayThreeAgo, sessionId: sid1, shortId: shortOf(sid1), count: 2 },
      { day: dayThreeAgo, sessionId: sid2, shortId: shortOf(sid2), count: 1 },
      { day: dayYesterday, sessionId: sid2, shortId: shortOf(sid2), count: 1 },
      { day: dayToday, sessionId: sid1, shortId: shortOf(sid1), count: 1 },
      { day: dayToday, sessionId: sid2, shortId: shortOf(sid2), count: 1 },
    ].sort((a, b) => a.day.localeCompare(b.day) || a.sessionId.localeCompare(b.sessionId));

    const text = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session-day"],
      baseEnv,
    );
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("6 event(s) across 5 session-day pair(s).");
    for (const b of expected) {
      expect(text.stdout).toContain(`${b.day} · ${b.shortId} ×${b.count}`);
    }

    const json = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session-day", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.workspace-journal-by-session-day");
    expect(record.count).toBe(6);
    expect(record.bySessionDay).toEqual(expected);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);
    expect(record.sessionsScanned).toBe(2);
  });

  it("composes with --kind and --since", async () => {
    const kindJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "note", "--by-session-day", "--output", "json"],
      baseEnv,
    );
    const kindRecord = JSON.parse(kindJson.stdout.trim());
    expect(kindRecord.count).toBe(2);
    const expected = [
      { day: dayThreeAgo, sessionId: sid1, shortId: shortOf(sid1), count: 1 },
      { day: dayYesterday, sessionId: sid2, shortId: shortOf(sid2), count: 1 },
    ].sort((a, b) => a.day.localeCompare(b.day) || a.sessionId.localeCompare(b.sessionId));
    expect(kindRecord.bySessionDay).toEqual(expected);

    // --since 1d keeps only the two live last-activity entries (one per
    // session, both today).
    const sinceJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--since", "1d", "--by-session-day", "--output", "json"],
      baseEnv,
    );
    const sinceRecord = JSON.parse(sinceJson.stdout.trim());
    expect(sinceRecord.count).toBe(2);
    expect(sinceRecord.bySessionDay).toEqual(
      [
        { day: dayToday, sessionId: sid1, shortId: shortOf(sid1), count: 1 },
        { day: dayToday, sessionId: sid2, shortId: shortOf(sid2), count: 1 },
      ].sort((a, b) => a.day.localeCompare(b.day) || a.sessionId.localeCompare(b.sessionId)),
    );
  });

  it("agrees with --count under identical flags", async () => {
    const pairsJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "1", "--limit", "2", "--by-session-day", "--output", "json"],
      baseEnv,
    );
    const grouped = JSON.parse(pairsJson.stdout.trim());
    const countJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "1", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(countJson.stdout.trim());
    expect(grouped.count).toBe(counted.count);
    expect(grouped.elided).toBe(counted.elided);
    expect(grouped.skipped).toBe(counted.skipped);
    const pairSum = (grouped.bySessionDay as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(pairSum).toBe(grouped.count);
  });

  it("reports an honest zero grouping for a matching-nothing filter", async () => {
    const empty = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-session-day"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-session-day", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyJson.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.bySessionDay).toEqual([]);
  });

  it("leaves unflagged output unchanged (no cross-tab fields on the full record)", async () => {
    const unflagged = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.bySessionDay).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(6);
  });
});
