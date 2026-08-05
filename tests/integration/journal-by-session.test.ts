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

describe("Integration: workspace journal by-session (--by-session, Issue #648)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sid1: string;
  let sid2: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-648i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-648i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    // Session 1: created + 3 notes + live last-activity = 5 entries.
    sid1 = store.newId();
    store.writeMeta(sid1, { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT });
    store.append(sid1, { role: "user", content: "by-session fodder 1" });
    for (let i = 0; i < 3; i++) {
      expect(appendSessionNote(store, sid1, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
    // Session 2: created + 1 note + live last-activity = 3 entries.
    sid2 = store.newId();
    store.writeMeta(sid2, { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT + 50 });
    store.append(sid2, { role: "user", content: "by-session fodder 2" });
    expect(appendSessionNote(store, sid2, "solo crumb", CREATED_AT + 5000).ok).toBe(true);
  });

  it("groups the workspace surface by session with text/JSON agreement", async () => {
    const text = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session"],
      baseEnv,
    );
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    const lines = text.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toBe("8 event(s) across 2 session(s).");
    // Count descending: session 1 (5 kept) before session 2 (3 kept).
    expect(lines[1]).toBe(`  ${sid1.slice(0, 8)} ×5`);
    expect(lines[2]).toBe(`  ${sid2.slice(0, 8)} ×3`);

    const json = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.workspace-journal-by-session");
    expect(record.count).toBe(8);
    expect(record.sessionsScanned).toBe(2);
    expect(record.bySession).toEqual([
      { shortId: sid1.slice(0, 8), sessionId: sid1, count: 5 },
      { shortId: sid2.slice(0, 8), sessionId: sid2, count: 3 },
    ]);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);
  });

  it("composes the grouping with filters and bounds identically to count/full render", async () => {
    const kindGroup = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "note", "--by-session"],
      baseEnv,
    );
    expect(kindGroup.code).toBe(0);
    const kindLines = kindGroup.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(kindLines[0]).toBe("4 event(s) across 2 session(s).");
    expect(kindLines[1]).toBe(`  ${sid1.slice(0, 8)} ×3`);
    expect(kindLines[2]).toBe(`  ${sid2.slice(0, 8)} ×1`);

    const pagedJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "2", "--limit", "2", "--by-session", "--output", "json"],
      baseEnv,
    );
    const grouped = JSON.parse(pagedJson.stdout.trim());
    const countJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "2", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(countJson.stdout.trim());
    const fullJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--skip", "2", "--limit", "2", "--output", "json"],
      baseEnv,
    );
    const full = JSON.parse(fullJson.stdout.trim());
    expect(grouped.count).toBe(counted.count);
    expect(grouped.elided).toBe(counted.elided);
    expect(grouped.skipped).toBe(counted.skipped);
    expect(grouped.count).toBe(full.entries.length);
    const bucketSum = (grouped.bySession as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(bucketSum).toBe(grouped.count);
  });

  it("emits session buckets only — no entry contents in the JSON", async () => {
    const json = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session", "--output", "json"],
      baseEnv,
    );
    expect(json.stdout).not.toContain('"entries"');
    expect(json.stdout).not.toContain('"detail"');
    expect(json.stdout).not.toContain("crumb");
    expect(json.stdout).not.toContain("order");
  });

  it("ignores --newest-first under --by-session", async () => {
    const plain = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session", "--output", "json"],
      baseEnv,
    );
    const flipped = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--by-session", "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(flipped.stdout).toBe(plain.stdout);
  });

  it("reports an honest zero grouping for a matching-nothing filter", async () => {
    const empty = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-session"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyJson = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--by-session", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(emptyJson.stdout.trim());
    expect(record.count).toBe(0);
    expect(record.bySession).toEqual([]);
  });

  it("leaves unflagged output unchanged (no by-session fields on the full record)", async () => {
    const unflagged = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.bySession).toBeUndefined();
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(8);
  });
});
