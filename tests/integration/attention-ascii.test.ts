import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { asciiSafeLine } from "../../src/ascii-output.js";

const CREATED_AT = 1_700_000_000_000;

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

// Age labels are clock-relative; normalize before cross-run comparisons.
function normalizeAges(s: string): string {
  return s.replace(/\b\d+(s|m|h|d) ago\b/g, "<age> ago");
}

function stripAgeMs(s: string): unknown {
  return JSON.parse(s, (k, v) => (k === "ageMs" ? undefined : v));
}

const GLYPHS = /[✓✗⚠⊘─·×…→↔]/;

describe("Integration: attention ascii rendering (--ascii, Issue #698)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-698i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-698i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    const id = store.newId();
    store.checkpoint(
      id,
      [
        { role: "user", content: "attention fodder" },
        { role: "assistant", content: "MAIN ANSWER" },
      ],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
  });

  it("keeps the default text rendering with its glyphs", async () => {
    const res = await runCli(["--attention", "--workspace", wsDir], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Attention — workspace");
    expect(res.stdout).toContain("─".repeat(40));
    expect(res.stdout).toContain("✓");
    expect(res.stdout).toContain("→");
  });

  it("maps every glyph under --ascii, leaving none behind", async () => {
    const res = await runCli(["--attention", "--workspace", wsDir, "--ascii"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[ok]");
    expect(res.stdout).toContain("-> ");
    expect(GLYPHS.test(res.stdout)).toBe(false);
  });

  it("keeps the ascii text identical to the default modulo the glyph map", async () => {
    const plain = await runCli(["--attention", "--workspace", wsDir], baseEnv);
    const ascii = await runCli(["--attention", "--workspace", wsDir, "--ascii"], baseEnv);
    const mapped = normalizeAges(plain.stdout)
      .split("\n")
      .map((line) => asciiSafeLine(line))
      .join("\n");
    expect(mapped).toBe(normalizeAges(ascii.stdout));
  });

  it("leaves --output json unchanged by --ascii", async () => {
    const plain = await runCli(["--attention", "--workspace", wsDir, "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const ascii = await runCli(
      ["--attention", "--workspace", wsDir, "--output", "json", "--ascii"],
      baseEnv,
    );
    expect(ascii.code).toBe(0);
    expect(stripAgeMs(ascii.stdout)).toStrictEqual(stripAgeMs(plain.stdout));
  });

  it("composes --ascii with --strict: mapped glyph-free output, exit 1", async () => {
    const res = await runCli(["--attention", "--workspace", wsDir, "--ascii", "--strict"], baseEnv);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("[ok]");
    expect(GLYPHS.test(res.stdout)).toBe(false);
  });

  it("keeps the store byte-identical through the runs", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    await runCli(["--attention", "--workspace", wsDir], baseEnv);
    await runCli(["--attention", "--workspace", wsDir, "--ascii"], baseEnv);
    await runCli(["--attention", "--workspace", wsDir, "--ascii", "--strict"], baseEnv);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
