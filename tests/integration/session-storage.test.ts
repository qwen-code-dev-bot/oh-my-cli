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

describe("Integration: session storage report (--storage-report, Issue #664)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let bigId: string;
  let smallId: string;
  let archivedId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-664i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    bigId = store.newId();
    store.checkpoint(
      bigId,
      [
        { role: "user", content: "x".repeat(400) },
        { role: "assistant", content: "y".repeat(400) },
      ],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1_700_000_000_000 },
    );
    expect(appendSessionNote(store, bigId, "big note", 2).ok).toBe(true);
    smallId = store.newId();
    store.checkpoint(smallId, [{ role: "user", content: "tiny" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1_700_000_100_000,
    });
    archivedId = store.newId();
    store.checkpoint(archivedId, [{ role: "user", content: "archived body" }], {
      model: "fake-model",
      workspace: "/srv/ws",
      createdAt: 1_700_000_200_000,
    });
    store.writeArchived(archivedId, 3);
  });

  it("ranks sessions largest-first with rollups in text and JSON", async () => {
    const text = await runCli(["--storage-report"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("Session storage report");
    expect(text.stdout).toContain("3 session(s), ");
    expect(text.stdout).toContain("Largest: ");
    expect(text.stdout).toContain("(archived)");
    // The big session's shortId appears first among the per-session lines.
    const bigShort = bigId.split("-")[0].slice(0, 8);
    const sessionLines = text.stdout
      .split("\n")
      .filter((l) => l.trim().startsWith("·") || /^\s+\S{8}/.test(l));
    const firstSessionLine = sessionLines[0];
    expect(firstSessionLine).toContain(bigShort);

    const json = await runCli(["--storage-report", "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-storage");
    expect(record.v).toBe(1);
    expect(record.sessionCount).toBe(3);
    expect(record.largestSessionId).toBe(bigId);
    expect(record.sessions.length).toBe(3);
    expect(record.sessions[0].sessionId).toBe(bigId);
    expect(record.totalBytes).toBe(record.sessions.reduce((a: number, s: { bytes: number }) => a + s.bytes, 0));
    const archived = record.sessions.find((s: { sessionId: string }) => s.sessionId === archivedId);
    expect(archived.archived).toBe(true);
    for (const s of record.sessions) {
      expect(s.bytes).toBe(s.transcriptBytes + s.sidecarBytes);
    }
    const bytes = record.sessions.map((s: { bytes: number }) => s.bytes);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
  });

  it("reports an empty store honestly", async () => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    const text = await runCli(["--storage-report"], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("0 session(s), 0B total.");

    const json = await runCli(["--storage-report", "--output", "json"], baseEnv);
    const record = JSON.parse(json.stdout.trim());
    expect(record.sessionCount).toBe(0);
    expect(record.totalBytes).toBe(0);
    expect(record.largestSessionId).toBeNull();
    expect(record.sessions).toEqual([]);
  });

  it("fails closed on a bad output format", async () => {
    const bad = await runCli(["--storage-report", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });

  it("never mutates the store through report reads", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const res = await runCli(["--storage-report", "--output", "json"], baseEnv);
    expect(res.code).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
