import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

function requestedModel(request: { body: unknown }): string {
  const body = request.body as { model?: string };
  return body.model ?? "";
}

describe("Integration: --model per-run override (Issue #791)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-model-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-model-sess-"));
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

  it("sends the overridden model to the provider and reports it in the JSON start event", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(
      ["-p", "Say done", "--model", "fake-alt", "--output", "json", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(requestedModel(server.requests[0])).toBe("fake-alt");
    const recs = parseHeadlessStream(r.stdout);
    const start = recs.find((rec) => rec.type === "start") as
      | { model?: string; sessionId?: string }
      | undefined;
    expect(start?.model).toBe("fake-alt");
    expect(typeof start?.sessionId).toBe("string");
  });

  it("uses the configured model without the flag (default unchanged)", async () => {
    server.setResponses([{ type: "text", content: "done" }]);

    const r = await runCli(["-p", "Say done", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    expect(requestedModel(server.requests[0])).toBe("fake-model");
  });

  it("fails closed on an empty override before any provider call", async () => {
    const r = await runCli(
      ["-p", "Say done", "--model", "   ", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("non-empty model name");
    expect(server.requests.length).toBe(0);
  });
});
