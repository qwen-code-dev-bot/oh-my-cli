import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BEL = "\x07";

const countBells = (text: string): number => text.split(BEL).length - 1;

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

describe("Integration: --bell turn-completion signal (Issue #783)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-bell-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-bell-sess-"));
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

  it("rings exactly one BEL on stdout when a normal run completes with --bell", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(["-p", "Say done", "--bell", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    expect(countBells(r.stdout)).toBe(1);
  });

  it("stays silent without --bell (off by default)", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(["-p", "Say done", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    expect(countBells(r.stdout)).toBe(0);
    expect(countBells(r.stderr)).toBe(0);
  });

  it("rings on stderr with --output json so the stdout NDJSON stays parseable", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "Say done", "--bell", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    // Protocol purity: no BEL on stdout, and every line still parses.
    expect(countBells(r.stdout)).toBe(0);
    const recs = parseHeadlessStream(r.stdout);
    expect(recs[recs.length - 1].type).toBe("complete");
    // The signal lands on stderr, exactly once.
    expect(countBells(r.stderr)).toBe(1);
  });

  it("does not ring when the run fails, even with --bell", async () => {
    server.setResponses([{ failWith: { status: 400 } }]);

    const r = await runCli(["-p", "Say done", "--bell", "--workspace", tmpDir], baseEnv);

    expect(r.code).not.toBe(0);
    expect(countBells(r.stdout)).toBe(0);
    expect(countBells(r.stderr)).toBe(0);
  });
});
