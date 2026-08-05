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
const NOTE_AT = 1_701_700_000_000; // 2023-12-04T14:26:40Z

describe("Integration: journal time window (--since/--until, Issue #634)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-634i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-634i-ws-"));
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
    store.append(sessionId, { role: "user", content: "window fodder" });
    expect(appendSessionNote(store, sessionId, "day-two crumb", NOTE_AT).ok).toBe(true);
  });

  it("bounds both surfaces to the window with text/JSON agreement", async () => {
    const since = new Date(NOTE_AT).toISOString();
    const until = new Date(NOTE_AT + 3_600_000).toISOString();

    const text = await runCli(
      ["--session-journal", sessionId, "--since", since, "--until", until],
      baseEnv,
    );
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("· note ·");
    expect(text.stdout).not.toContain("· created ·");
    expect(text.stdout).not.toContain("· last-activity ·");

    const json = await runCli(
      ["--session-journal", sessionId, "--since", since, "--until", until, "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBeGreaterThan(0);
    expect(
      record.entries.every(
        (e: { at: number }) => e.at >= NOTE_AT && e.at <= NOTE_AT + 3_600_000,
      ),
    ).toBe(true);
    expect(record.entries.every((e: { kind: string }) => e.kind === "note")).toBe(true);

    // A bare date expands to the whole UTC day and keeps the same semantics.
    const dateOnly = await runCli(
      ["--session-journal", sessionId, "--since", "2023-12-04", "--until", "2023-12-04", "--output", "json"],
      baseEnv,
    );
    expect(dateOnly.code).toBe(0);
    const dateRecord = JSON.parse(dateOnly.stdout.trim());
    expect(dateRecord.entries.every((e: { kind: string }) => e.kind === "note")).toBe(true);
    expect(dateRecord.entries.length).toBe(record.entries.length);

    // The workspace journal honors the same window.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--since", since, "--until", until, "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBeGreaterThan(0);
    expect(
      wsRecord.entries.every(
        (e: { at: number }) => e.at >= NOTE_AT && e.at <= NOTE_AT + 3_600_000,
      ),
    ).toBe(true);

    // The window composes with the kind filter.
    const composed = await runCli(
      ["--session-journal", sessionId, "--since", "2023-12-03", "--kind", "note", "--output", "json"],
      baseEnv,
    );
    expect(composed.code).toBe(0);
    const composedRecord = JSON.parse(composed.stdout.trim());
    expect(composedRecord.entries.every((e: { kind: string }) => e.kind === "note")).toBe(true);
    expect(composedRecord.entries.length).toBeGreaterThan(0);
  });

  it("leaves unfiltered output unchanged", async () => {
    const unfiltered = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    expect(unfiltered.code).toBe(0);
    const record = JSON.parse(unfiltered.stdout.trim());
    const kinds = record.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("note");
    expect(kinds).toContain("last-activity");
  });

  it("fails closed on garbage and inverted windows", async () => {
    const garbage = await runCli(["--session-journal", sessionId, "--since", "not-a-date"], baseEnv);
    expect(garbage.code).toBe(2);
    expect(garbage.stderr).toContain("invalid --since timestamp");
    expect(garbage.stdout).toBe("");

    const inverted = await runCli(
      ["--session-journal", sessionId, "--since", "2023-12-05", "--until", "2023-12-04"],
      baseEnv,
    );
    expect(inverted.code).toBe(2);
    expect(inverted.stderr).toContain("--since must not be after --until");
    expect(inverted.stdout).toBe("");

    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--until", "someday"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("invalid --until timestamp");
  });

  it("renders the honest empty state for a window matching nothing", async () => {
    const empty = await runCli(
      ["--session-journal", sessionId, "--since", "2030-01-01"],
      baseEnv,
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No journal entries.");

    const emptyWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--since", "2030-01-01"],
      baseEnv,
    );
    expect(emptyWs.code).toBe(0);
    expect(emptyWs.stdout).toContain("No journal entries for this workspace.");
  });
});
