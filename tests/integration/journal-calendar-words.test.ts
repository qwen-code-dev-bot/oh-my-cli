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

describe("Integration: calendar words in --since/--until (Issue #654)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;
  let startOfToday: number;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-654i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-654i-ws-"));
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
    // Created two days ago at 02:00 UTC; one note yesterday at 01:00 UTC;
    // last-activity is live (today).
    store.writeMeta(sessionId, {
      model: "fake-model",
      workspace: wsDir,
      createdAt: startOfToday - 2 * DAY + 2 * 3_600_000,
    });
    store.append(sessionId, { role: "user", content: "calendar word fodder" });
    expect(
      appendSessionNote(store, sessionId, "yesterday crumb", startOfToday - DAY + 3_600_000).ok,
    ).toBe(true);
  });

  it("--since today keeps only today's entries on both surfaces", async () => {
    const text = await runCli(["--session-journal", sessionId, "--since", "today"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("1 event(s).");
    expect(text.stdout).toContain("last-activity");
    expect(text.stdout).not.toContain("created");
    expect(text.stdout).not.toContain("yesterday crumb");

    const json = await runCli(
      ["--session-journal", sessionId, "--since", "today", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(1);
    expect(record.entries[0].kind).toBe("last-activity");

    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--since", "today", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBe(1);
    expect(wsRecord.entries[0].kind).toBe("last-activity");
  });

  it("--since yesterday --until yesterday isolates the preceding day", async () => {
    const json = await runCli(
      ["--session-journal", sessionId, "--since", "yesterday", "--until", "yesterday", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(1);
    expect(record.entries[0].kind).toBe("note");
    expect(record.entries[0].detail).toContain("yesterday crumb");
  });

  it("--since yesterday --until today spans both days", async () => {
    const json = await runCli(
      ["--session-journal", sessionId, "--since", "yesterday", "--until", "today", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    // Yesterday's note + today's live last-activity; created (two days old)
    // stays excluded.
    expect(record.entries.length).toBe(2);
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("note");
    expect(kinds).toContain("last-activity");
    expect(kinds).not.toContain("created");
  });

  it("fails closed on an inverted calendar window", async () => {
    const inverted = await runCli(
      ["--session-journal", sessionId, "--since", "today", "--until", "yesterday"],
      baseEnv,
    );
    expect(inverted.code).toBe(2);
    expect(inverted.stderr).toContain("--since must not be after --until");
    expect(inverted.stdout).toBe("");
  });

  it("fails closed on unknown calendar words with the hint", async () => {
    for (const bad of ["tomorrow", "last-week", "Today"]) {
      const res = await runCli(["--session-journal", sessionId, "--since", bad], baseEnv);
      expect(res.code, `since=${bad} stderr: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("invalid --since timestamp");
      expect(res.stderr).toContain("today/yesterday");
      expect(res.stdout).toBe("");
    }
    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--until", "tomorrow"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("invalid --until timestamp");
  });

  it("keeps ISO, date, and relative inputs unchanged", async () => {
    const iso = await runCli(
      ["--session-journal", sessionId, "--since", "2020-01-01", "--output", "json"],
      baseEnv,
    );
    expect(iso.code).toBe(0);
    expect(JSON.parse(iso.stdout.trim()).entries.length).toBe(3);

    const relative = await runCli(
      ["--session-journal", sessionId, "--since", "30m", "--output", "json"],
      baseEnv,
    );
    expect(relative.code).toBe(0);
    expect(JSON.parse(relative.stdout.trim()).entries.length).toBe(1);
  });
});
