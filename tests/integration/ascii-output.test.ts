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

const NON_ASCII = /[^\x00-\x7F]/;
const GLYPH_MAP: Record<string, string> = { "\u2500": "-", "\u00b7": "|", "\u00d7": "x", "\u2014": "-" };
function mapGlyphs(text: string): string {
  return text.replace(/[\u2500\u00b7\u00d7\u2014]/g, (ch) => GLYPH_MAP[ch]);
}

describe("Integration: ASCII-safe output (--ascii, Issue #672)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-672i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-672i-ws-"));
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
    store.writeMeta(sessionId, { model: "fake-model", workspace: wsDir, createdAt: 1_700_000_000_000 });
    store.append(sessionId, { role: "user", content: "ascii fodder" });
    expect(appendSessionNote(store, sessionId, "ascii note", 1_700_000_100_000).ok).toBe(true);
    fs.writeFileSync(path.join(sessionsDir(), `${sessionId}.goal.json`), "{torn goal");
  });

  async function checkSurface(args: string[], expectGlyphs: boolean): Promise<void> {
    const plain = await runCli(args, baseEnv);
    expect(plain.code, `stderr: ${plain.stderr}`).toBe(0);
    // Surfaces with decorative separators keep their glyphs by default.
    if (expectGlyphs) {
      expect(NON_ASCII.test(plain.stdout)).toBe(true);
    }

    const ascii = await runCli([...args, "--ascii"], baseEnv);
    expect(ascii.code, `stderr: ${ascii.stderr}`).toBe(0);
    // ASCII output carries no non-ASCII characters at all.
    expect(NON_ASCII.test(ascii.stdout)).toBe(false);
    // Content equality modulo the glyph map.
    expect(mapGlyphs(plain.stdout)).toBe(ascii.stdout);
    // Same structure: identical line counts.
    expect(ascii.stdout.split("\n").length).toBe(plain.stdout.split("\n").length);
  }

  it("renders session-journal ASCII-safe with content preserved", async () => {
    await checkSurface(["--session-journal", sessionId], true);
  });

  it("renders workspace-journal and aggregation modes ASCII-safe", async () => {
    await checkSurface(["--workspace-journal", "--workspace", wsDir], true);
    await checkSurface(["--workspace-journal", "--workspace", wsDir, "--by-day"], true);
    await checkSurface(["--workspace-journal", "--workspace", wsDir, "--by-session"], true);
    // Count output carries no decorative glyphs even by default.
    await checkSurface(["--workspace-journal", "--workspace", wsDir, "--count"], false);
    await checkSurface(["--session-journal", sessionId, "--by-day"], true);
    await checkSurface(["--session-journal", sessionId, "--count"], false);
  });

  it("renders the report surfaces ASCII-safe", async () => {
    await checkSurface(["--health-report"], true);
    await checkSurface(["--storage-report"], true);
    await checkSurface(["--store-doctor"], true);
    await checkSurface(["--stale-sessions"], true);
    await checkSurface(["--sessions-overview"], true);
  });

  it("leaves JSON byte-identical with and without --ascii", async () => {
    for (const args of [
      ["--session-journal", sessionId],
      ["--workspace-journal", "--workspace", wsDir],
      ["--health-report"],
      ["--store-doctor"],
    ]) {
      const plain = await runCli([...args, "--output", "json"], baseEnv);
      const ascii = await runCli([...args, "--output", "json", "--ascii"], baseEnv);
      expect(ascii.code).toBe(0);
      expect(ascii.stdout).toBe(plain.stdout);
    }
  });

  it("still fails closed on a bad output format with --ascii", async () => {
    const bad = await runCli(["--health-report", "--ascii", "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid output format "yaml"');
    expect(bad.stdout).toBe("");
  });
});
