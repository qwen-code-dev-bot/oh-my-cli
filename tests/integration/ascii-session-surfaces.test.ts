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
const GLYPH_MAP: Record<string, string> = {
  "\u2500": "-",
  "\u00b7": "|",
  "\u00d7": "x",
  "\u2014": "-",
  "\u2026": "...",
  "\u2192": "->",
  "\u2194": "<->",
  "\u2713": "[ok]",
  "\u2717": "[bad]",
};
function mapGlyphs(text: string): string {
  return text.replace(/[\u2500\u00b7\u00d7\u2014\u2026\u2192\u2194\u2713\u2717]/g, (ch) => GLYPH_MAP[ch]);
}
// Normalize wall-clock relative ages ("3s ago") that differ between the two
// runs happening a second apart.
function normalizeWallClock(text: string): string {
  return text.replace(/\d+s ago/g, "Xs ago").replace(/last active .*$/gm, "last active X");
}

describe("Integration: --ascii on the session surfaces (Issue #674)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let idA: string;
  let idB: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-674i-home-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    idA = store.newId();
    store.checkpoint(
      idA,
      [
        { role: "user", content: "shared prefix" },
        { role: "assistant", content: "shared answer" },
        { role: "user", content: "branch A" },
      ],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1_700_000_000_000 },
    );
    expect(appendSessionNote(store, idA, "searchable crumb", 1_700_000_100_000).ok).toBe(true);
    idB = store.newId();
    store.checkpoint(
      idB,
      [
        { role: "user", content: "shared prefix" },
        { role: "assistant", content: "shared answer" },
        { role: "user", content: "branch B" },
      ],
      { model: "fake-model", workspace: "/srv/ws", createdAt: 1_700_000_200_000 },
    );
  });

  async function checkSurface(args: string[]): Promise<void> {
    const plain = await runCli(args, baseEnv);
    expect(plain.code, `stderr: ${plain.stderr}`).toBe(0);

    const ascii = await runCli([...args, "--ascii"], baseEnv);
    expect(ascii.code, `stderr: ${ascii.stderr}`).toBe(0);
    // ASCII output carries no non-ASCII characters at all.
    expect(NON_ASCII.test(ascii.stdout)).toBe(false);
    // Content equality modulo the glyph map (and wall-clock relative ages).
    expect(normalizeWallClock(mapGlyphs(plain.stdout))).toBe(normalizeWallClock(ascii.stdout));
    // Same structure: identical line counts.
    expect(ascii.stdout.split("\n").length).toBe(plain.stdout.split("\n").length);

    // JSON is byte-identical with and without --ascii.
    const plainJson = await runCli([...args, "--output", "json"], baseEnv);
    const asciiJson = await runCli([...args, "--output", "json", "--ascii"], baseEnv);
    expect(asciiJson.code).toBe(0);
    expect(asciiJson.stdout).toBe(plainJson.stdout);
  }

  it("renders --session-stats ASCII-safe", async () => {
    await checkSurface(["--session-stats", idA]);
  });

  it("renders --inspect-session ASCII-safe, mapping the semantic status marks", async () => {
    const plain = await runCli(["--inspect-session", idA], baseEnv);
    expect(plain.code).toBe(0);
    // Inspect emits semantic status marks by default...
    expect(/[\u2713\u2717]/.test(plain.stdout)).toBe(true);

    await checkSurface(["--inspect-session", idA]);

    const ascii = await runCli(["--inspect-session", idA, "--ascii"], baseEnv);
    expect(ascii.code).toBe(0);
    // ...which become readable ASCII marks.
    expect(/\[ok\]|\[bad\]/.test(ascii.stdout)).toBe(true);
    expect(/[\u2713\u2717]/.test(ascii.stdout)).toBe(false);
  });

  it("renders --session-notes ASCII-safe", async () => {
    await checkSurface(["--session-notes", idA]);
  });

  it("renders --diff-sessions ASCII-safe", async () => {
    await checkSurface(["--diff-sessions", idA, idB]);
  });

  it("renders --search-notes ASCII-safe", async () => {
    await checkSurface(["--search-notes", "crumb"]);
  });
});
