import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const TITLE_OSC_MARKERS = ["\x1b]0;", "\x1b]2;"];

const containsTitleOsc = (text: string): boolean =>
  TITLE_OSC_MARKERS.some((marker) => text.includes(marker));

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

describe("Integration: --title is inert on headless paths (Issue #785)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-title-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-title-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  it("writes zero title OSC bytes on a headless -p run, even with explicit --title text", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "Say done", "--title", "should never appear", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(containsTitleOsc(r.stdout)).toBe(false);
    expect(containsTitleOsc(r.stderr)).toBe(false);
  });

  it("writes zero title OSC bytes on a headless JSON run with --title", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "Say done", "--title", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(containsTitleOsc(r.stdout)).toBe(false);
    expect(containsTitleOsc(r.stderr)).toBe(false);
  });
});
