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

const CREATED_AT = 1_701_600_000_000; // 2023-12-03T10:40:00Z — > 30d ago → absolute date

describe("Integration: journal relative rendering (--relative, Issue #650)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function entryLines(stdout: string): string[] {
    return stdout.split("\n").filter((l) => l.trim().startsWith("2") || l.includes("ago") || l.includes("just now"));
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-650i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-650i-ws-"));
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
    store.append(sessionId, { role: "user", content: "relative fodder" });
    for (let i = 0; i < 2; i++) {
      expect(appendSessionNote(store, sessionId, `crumb ${i}`, CREATED_AT + 1000 + i * 1000).ok).toBe(true);
    }
  });

  // Fixture: created + 2 notes (all 2023-12-03, > 30d ago → absolute date),
  // last-activity live (~now → "just now").

  it("renders ages on both surfaces in text mode", async () => {
    const text = await runCli(["--session-journal", sessionId, "--relative"], baseEnv);
    expect(text.code, `stderr: ${text.stderr}`).toBe(0);
    const lines = entryLines(text.stdout);
    expect(lines.length).toBe(4);
    // Old entries fall back to the absolute UTC date.
    expect(text.stdout).toContain("2023-12-03 · created");
    expect(text.stdout).toContain("2023-12-03 · note");
    // The live last-activity entry is under 60s old.
    expect(text.stdout).toContain("just now · last-activity");
    // No ISO timestamps remain in entry lines.
    for (const l of lines) {
      expect(l).not.toContain("T10:40:00");
    }

    const ws = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--relative"],
      baseEnv,
    );
    expect(ws.code, `stderr: ${ws.stderr}`).toBe(0);
    expect(ws.stdout).toContain("2023-12-03 · ");
    // Workspace lines carry the shortId between the timestamp and the kind.
    expect(ws.stdout).toContain("just now · ");
    expect(ws.stdout).toContain("· last-activity ·");
  });

  it("keeps JSON byte-identical under --relative", async () => {
    const plain = await runCli(["--session-journal", sessionId, "--output", "json"], baseEnv);
    const relative = await runCli(
      ["--session-journal", sessionId, "--relative", "--output", "json"],
      baseEnv,
    );
    expect(relative.code).toBe(0);
    expect(relative.stdout).toBe(plain.stdout);

    const wsPlain = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--output", "json"],
      baseEnv,
    );
    const wsRelative = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--relative", "--output", "json"],
      baseEnv,
    );
    expect(wsRelative.stdout).toBe(wsPlain.stdout);
  });

  it("composes with filters — kept set identical, only the column differs", async () => {
    const plain = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--output", "json"],
      baseEnv,
    );
    const relative = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--relative", "--output", "json"],
      baseEnv,
    );
    expect(relative.stdout).toBe(plain.stdout);

    const relativeText = await runCli(
      ["--session-journal", sessionId, "--kind", "note", "--relative"],
      baseEnv,
    );
    expect(relativeText.code).toBe(0);
    expect(relativeText.stdout).toContain("2 event(s).");
    expect(relativeText.stdout).not.toContain("created");
    expect(relativeText.stdout).toContain("2023-12-03 · note");
  });

  it("leaves unflagged text output unchanged (ISO timestamps present)", async () => {
    const unflagged = await runCli(["--session-journal", sessionId], baseEnv);
    expect(unflagged.code).toBe(0);
    expect(unflagged.stdout).toContain("T10:40:00.000Z · created");
    expect(unflagged.stdout).not.toContain("ago ·");
  });
});
