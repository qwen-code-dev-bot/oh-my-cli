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

const NOW = 1_701_700_000_000;

describe("Integration: journal kind filter (--kind, Issue #632)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-632i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-632i-ws-"));
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
    store.writeMeta(sessionId, { model: "fake-model", workspace: wsDir, createdAt: NOW });
    store.append(sessionId, { role: "user", content: "filter fodder" });
    expect(appendSessionNote(store, sessionId, "filter crumb", NOW).ok).toBe(true);
  });

  it("filters both surfaces to the requested kinds with text/JSON agreement", async () => {
    const text = await runCli(
      ["--session-journal", sessionId, "--kind", "note"],
      baseEnv,
    );
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    expect(text.stdout).toContain("· note ·");
    expect(text.stdout).not.toContain("· created ·");
    expect(text.stdout).not.toContain("· last-activity ·");

    const json = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--output", "json"],
      baseEnv,
    );
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout.trim());
    expect(record.entries.length).toBeGreaterThan(0);
    expect(record.entries.every((e: { kind: string }) => e.kind === "note")).toBe(true);

    // Multi-kind filter.
    const multi = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "created", "--output", "json"],
      baseEnv,
    );
    expect(multi.code).toBe(0);
    const multiRecord = JSON.parse(multi.stdout.trim());
    expect(
      multiRecord.entries.every((e: { kind: string }) => e.kind === "note" || e.kind === "created"),
    ).toBe(true);

    // Workspace journal honors the same filter.
    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "note", "--output", "json"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    const wsRecord = JSON.parse(ws.stdout.trim());
    expect(wsRecord.entries.length).toBeGreaterThan(0);
    expect(wsRecord.entries.every((e: { kind: string }) => e.kind === "note")).toBe(true);
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

  it("fails closed on an unknown kind listing the valid taxonomy", async () => {
    const bad = await runCli(["--session-journal", sessionId, "--kind", "bogus"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown journal kind(s): bogus");
    expect(bad.stderr).toContain("created, goal, note, pinned, archived, last-activity");
    expect(bad.stdout).toBe("");

    const badWs = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--kind", "bogus"],
      baseEnv,
    );
    expect(badWs.code).toBe(2);
    expect(badWs.stderr).toContain("unknown journal kind(s): bogus");
  });

  it("renders the honest empty state for a filter matching nothing", async () => {
    const empty = await runCli(["--session-journal", sessionId, "--kind", "archived"], baseEnv);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No journal entries.");
  });
});
