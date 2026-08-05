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

describe("Integration: relative time specs in --since/--until (Issue #652)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-652i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-652i-ws-"));
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
    store.append(sessionId, { role: "user", content: "relative window fodder" });
    for (let i = 0; i < 2; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  // Fixture: created + 2 notes on 2023-12-03 (years old), last-activity
  // live (~seconds old).

  it("selects only fresh entries under a small relative offset on both surfaces", async () => {
    const text = await runCli(["--session-journal", sessionId, "--since", "5m"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("1 event(s).");
    expect(text.stdout).toContain("last-activity");
    expect(text.stdout).not.toContain("created");
    expect(text.stdout).not.toContain("crumb");

    const json = await runCli(
      ["--session-journal", sessionId, "--since", "5m", "--output", "json"],
      baseEnv,
    );
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(1);
    expect(record.entries[0].kind).toBe("last-activity");

    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--since", "5m", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBe(1);
    expect(wsRecord.entries[0].kind).toBe("last-activity");
  });

  it("mixes relative and absolute bounds", async () => {
    // since = start of 2023-12-03, until = one day before read time (2026):
    // keeps the three 2023 entries, excludes the live last-activity.
    const json = await runCli(
      ["--session-journal", sessionId, "--since", "2023-12-03", "--until", "1d", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(3);
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("note");
    expect(kinds).not.toContain("last-activity");
  });

  it("fails closed on an inverted relative window", async () => {
    const inverted = await runCli(
      ["--session-journal", sessionId, "--since", "1d", "--until", "3d"],
      baseEnv,
    );
    expect(inverted.code).toBe(2);
    expect(inverted.stderr).toContain("--since must not be after --until");
    expect(inverted.stdout).toBe("");
  });

  it("fails closed on malformed relative specs with the hint", async () => {
    for (const bad of ["5x", "d5", "-2h", "1.5d"]) {
      const res = await runCli(["--session-journal", sessionId, "--since", bad], baseEnv);
      expect(res.code, `since=${bad} stderr: ${res.stderr}`).toBe(2);
      expect(res.stderr).toContain("invalid --since timestamp");
      expect(res.stderr).toContain("30s/45m/6h/2d/1w/now");
      expect(res.stdout).toBe("");
    }
    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--until", "5x"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("invalid --until timestamp");
  });

  it("keeps ISO inputs behaving exactly as before", async () => {
    // since start of 2023-12-04 excludes the Dec-3 created + notes and keeps
    // only the live last-activity.
    const json = await runCli(
      ["--session-journal", sessionId, "--since", "2023-12-04", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBe(1);
    expect(record.entries[0].kind).toBe("last-activity");
  });
});
