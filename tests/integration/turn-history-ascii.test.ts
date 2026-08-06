import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { appendCheckpoint, type TurnCheckpoint } from "../../src/turn-checkpoint.js";
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

const GLYPHS = /[✓✗⚠⊘─·×…→↔]/;

describe("Integration: turn history ascii rendering (--ascii, Issue #700)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function checkpoint(turnIndex: number, before: number, after: number): TurnCheckpoint {
    return {
      schema: "oh-my-cli.turn-checkpoint",
      v: 1,
      sessionId,
      turnIndex,
      head: null,
      messageCountBefore: before,
      messageCountAfter: after,
      messages: [{ role: "user", content: "fixture" }],
      files: [],
      digest: "0".repeat(64),
    };
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-700i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-700i-ws-"));
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
    store.checkpoint(
      sessionId,
      [{ role: "user", content: "history fodder" }],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
    appendCheckpoint(store, sessionId, checkpoint(0, 0, 1));
    appendCheckpoint(store, sessionId, checkpoint(1, 1, 3));
  });

  it("keeps the default text rendering with its glyphs", async () => {
    const res = await runCli(["--turn-history", sessionId], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Turn history — session");
    expect(res.stdout).toContain("─".repeat(40));
    expect(res.stdout).toContain("·");
    expect(res.stdout).toContain("→");
  });

  it("maps every glyph under --ascii, leaving none behind", async () => {
    const res = await runCli(["--turn-history", sessionId, "--ascii"], baseEnv);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("-> ");
    expect(GLYPHS.test(res.stdout)).toBe(false);
  });

  it("keeps the ascii text byte-identical to the default modulo the glyph map", async () => {
    const plain = await runCli(["--turn-history", sessionId], baseEnv);
    const ascii = await runCli(["--turn-history", sessionId, "--ascii"], baseEnv);
    // Turn-history rendering carries no wall-clock values, so the mapping
    // is exact line-for-line.
    const mapped = plain.stdout
      .split("\n")
      .map((line) => asciiSafeLine(line))
      .join("\n");
    expect(mapped).toBe(ascii.stdout);
  });

  it("leaves --output json unchanged by --ascii", async () => {
    const plain = await runCli(["--turn-history", sessionId, "--output", "json"], baseEnv);
    expect(plain.code).toBe(0);
    const ascii = await runCli(["--turn-history", sessionId, "--output", "json", "--ascii"], baseEnv);
    expect(ascii.code).toBe(0);
    expect(ascii.stdout).toBe(plain.stdout);
  });

  it("keeps the store byte-identical through the runs", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    await runCli(["--turn-history", sessionId], baseEnv);
    await runCli(["--turn-history", sessionId, "--ascii"], baseEnv);
    await runCli(["--turn-history", sessionId, "--output", "json", "--ascii"], baseEnv);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
