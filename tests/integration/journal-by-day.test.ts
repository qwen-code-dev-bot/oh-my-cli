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
const CREATED_DAY = "2023-12-03";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("Integration: journal by-day (--by-day, Issue #646)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-646i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-646i-ws-"));
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
    store.append(sessionId, { role: "user", content: "by-day fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  // Fixture: created + 4 notes on 2023-12-03, last-activity today = 6
  // entries across 2 days.

  it("groups both surfaces by day with text/JSON agreement", async () => {
    const text = await runCli(["--session-journal", sessionId, "--by-day"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    const lines = text.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toBe("6 event(s) across 2 day(s).");
    expect(lines[1]).toBe(`  ${CREATED_DAY} ×5`);
    expect(lines[2]).toBe(`  ${todayUtc()} ×1`);

    const json = await runCli(["--session-journal", sessionId, "--by-day", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal-by-day");
    expect(record.count).toBe(6);
    expect(record.byDay).toEqual([
      { day: CREATED_DAY, count: 5 },
      { day: todayUtc(), count: 1 },
    ]);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);

    // The workspace surface groups too.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-day", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.schema).toBe("oh-my-cli.workspace-journal-by-day");
    expect(wsRecord.count).toBe(6);
    expect(wsRecord.byDay).toEqual([
      { day: CREATED_DAY, count: 5 },
      { day: todayUtc(), count: 1 },
    ]);
    expect(wsRecord.sessionsScanned).toBe(1);
  });

  it("composes the grouping with filters and bounds identically to count/full render", async () => {
    const kindGroup = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--by-day"],
      baseEnv,
    );
    expect(kindGroup.code).toBe(0);
    const kindLines = kindGroup.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(kindLines[0]).toBe("4 event(s) across 1 day(s).");
    expect(kindLines[1]).toBe(`  ${CREATED_DAY} ×4`);

    const paged = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--by-day"],
      baseEnv,
    );
    expect(paged.code).toBe(0);
    const pagedLines = paged.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(pagedLines[0]).toBe(
      "2 event(s) across 1 day(s). (+2 older event(s) not shown) (+2 newer event(s) skipped)",
    );
    expect(pagedLines[1]).toBe(`  ${CREATED_DAY} ×2`);

    // The buckets agree with --count and the full render under the same flags.
    const pagedJson = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--by-day", "--output", "json"],
      baseEnv,
    );
    const grouped = JSON.parse(pagedJson.stdout.trim());
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
    expect(grouped.count).toBe(counted.count);
    expect(grouped.elided).toBe(counted.elided);
    expect(grouped.skipped).toBe(counted.skipped);
    expect(grouped.count).toBe(full.entries.length);
    const bucketSum = (grouped.byDay as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(bucketSum).toBe(grouped.count);
  });

  it("emits day buckets only — no entry contents in the JSON", async () => {
    const json = await runCli(["--session-journal", sessionId, "--by-day", "--output", "json"], baseEnv);
    expect(json.stdout).not.toContain('"entries"');
    expect(json.stdout).not.toContain('"detail"');
    expect(json.stdout).not.toContain("crumb");
    expect(json.stdout).not.toContain("order");
  });

  it("ignores --newest-first under --by-day", async () => {
    const plain = await runCli(["--session-journal", sessionId, "--by-day", "--output", "json"], baseEnv);
    const flipped = await runCli(
      ["--session-journal", sessionId, "--by-day", "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(flipped.stdout).toBe(plain.stdout);
  });

  it("reports an honest zero grouping for a matching-nothing filter", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--kind", "archived", "--by-day"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-day", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyWs.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.byDay).toEqual([]);
  });

  it("leaves unflagged output unchanged (no by-day fields on the full record)", async () => {
    const unflagged = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.byDay).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(6);
  });
});
