import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// The full-screen shell must never alter the non-interactive byte contracts.
// These runs are spawned with piped stdio (never a TTY), so the shell is never
// selected; the assertions guard that boundary and the existing -p / JSON /
// diagnostic output.
const ALT_SCREEN = /\x1b\[\?1049[hl]/;
const ANSI = /\x1b\[/;

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

describe("Integration: tui-shell non-interactive regression", () => {
  let server: FakeServer;
  let homeDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-tui-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("keeps -p plain output free of any shell screen control", async () => {
    server.setResponse({ type: "text", content: "plain answer" });
    const r = await runCli(["-p", "Hello"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plain answer");
    expect(r.stdout).not.toMatch(ALT_SCREEN);
    expect(r.stderr).not.toMatch(ALT_SCREEN);
  });

  it("preserves the headless JSON protocol", async () => {
    server.setResponse({ type: "text", content: "json answer" });
    const r = await runCli(["-p", "Hello", "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(ALT_SCREEN);
    const records = r.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(records[0].type).toBe("start");
    const complete = records.find((x) => x.type === "complete");
    expect(complete).toBeTruthy();
    expect(complete.exitCode).toBe(0);
  });

  it("preserves diagnostic command output", async () => {
    const r = await runCli(["--doctor"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).not.toMatch(ALT_SCREEN);
  });

  it("errors for interactive mode without a TTY instead of launching the shell", async () => {
    const r = await runCli([], baseEnv);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("requires a TTY");
    expect(r.stdout).not.toMatch(ALT_SCREEN);
    expect(r.stderr).not.toMatch(ANSI);
  });

  it("never emits the shortcut help panel into non-interactive -p output", async () => {
    // A `?` in the prompt must not conjure the interactive help panel off the TTY
    // path (Issue #169): the panel is a full-screen-shell affordance only.
    server.setResponse({ type: "text", content: "answer with ? mark" });
    const r = await runCli(["-p", "Hello ?"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("answer with ? mark");
    expect(r.stdout).not.toContain("Keyboard shortcuts");
    expect(r.stderr).not.toContain("Keyboard shortcuts");
    expect(r.stdout).not.toMatch(ALT_SCREEN);
  });
});
