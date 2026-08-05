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

describe("Integration: journal count (--count, Issue #642)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-642i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-642i-ws-"));
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
    store.append(sessionId, { role: "user", content: "count fodder" });
    for (let i = 0; i < 4; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  // Fixture: created, 4 notes, last-activity (live mtime) = 6 entries.

  it("counts both surfaces with text/JSON agreement and full-render equivalence", async () => {
    const text = await runCli(["--session-journal", sessionId, "--count"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout.trim()).toBe("6 event(s).");

    const json = await runCli(["--session-journal", sessionId, "--count", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-journal-count");
    expect(record.count).toBe(6);
    expect(record.elided).toBe(0);
    expect(record.skipped).toBe(0);

    // Counts equal the full render's kept set under identical flags.
    const full = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    const fullRecord = JSON.parse(full.stdout.trim());
    expect(record.count).toBe(fullRecord.entries.length);

    // The workspace surface counts too.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--count", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.schema).toBe("oh-my-cli.workspace-journal-count");
    expect(wsRecord.count).toBe(6);
    expect(wsRecord.sessionsScanned).toBe(1);
  });

  it("composes the count with filters and bounds identically to the full render", async () => {
    const kindCount = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--count", "--output", "json"],
      baseEnv,
    );
    expect(JSON.parse(kindCount.stdout.trim()).count).toBe(4);

    const paged = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--count"],
      baseEnv,
    );
    expect(paged.code).toBe(0);
    expect(paged.stdout.trim()).toBe("2 event(s). (+2 older event(s) not shown) (+2 newer event(s) skipped)");

    const pagedJson = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--count", "--output", "json"],
      baseEnv,
    );
    const counted = JSON.parse(pagedJson.stdout.trim());
    expect(counted.count).toBe(2);
    expect(counted.elided).toBe(2);
    expect(counted.skipped).toBe(2);

    // Identical to the full render's counts under the same flags.
    const fullPaged = await runCli(
      ["--session-journal", sessionId, "--skip", "2", "--limit", "2", "--output", "json"],
      baseEnv,
    );
    const fullRecord = JSON.parse(fullPaged.stdout.trim());
    expect(counted.count).toBe(fullRecord.entries.length);
    expect(counted.elided).toBe(fullRecord.elided);
    expect(counted.skipped).toBe(fullRecord.skipped);
  });

  it("emits counts only — no entry contents in the JSON", async () => {
    const json = await runCli(["--session-journal", sessionId, "--count", "--output", "json"], baseEnv);
    expect(json.stdout).not.toContain('"entries"');
    expect(json.stdout).not.toContain('"detail"');
    expect(json.stdout).not.toContain("crumb");
    expect(json.stdout).not.toContain("order");
  });

  it("ignores --newest-first under --count", async () => {
    const plain = await runCli(["--session-journal", sessionId, "--count", "--output", "json"], baseEnv);
    const flipped = await runCli(
      ["--session-journal", sessionId, "--count", "--newest-first", "--output", "json"],
      baseEnv,
    );
    expect(flipped.stdout).toBe(plain.stdout);
  });

  it("reports an honest zero count for a matching-nothing filter", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--kind", "archived", "--count"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("0 event(s).");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "archived", "--count", "--output", "json"],
      baseEnv,
    );
    expect(JSON.parse(emptyWs.stdout.trim()).count).toBe(0);
  });

  it("leaves unflagged output unchanged (no count field on the full record)", async () => {
    const unflagged = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    const record = JSON.parse(unflagged.stdout.trim());
    expect(record.count).toBeUndefined();
    expect(record.entries.length).toBe(6);
  });
});
