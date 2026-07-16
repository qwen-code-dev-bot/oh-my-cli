import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { RETRY_MAX_DELAY_MS } from "../../src/provider.js";
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

describe("Integration: provider transient-error retry", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-retry-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-retry-sess-"));
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

  it("retries a transient 503 and succeeds on the next attempt", async () => {
    server.setResponses([{ failWith: { status: 503 } }, { type: "text", content: "recovered" }]);

    const r = await runCli(
      ["-p", "hello", "--output", "json", "--summary", "--workspace", tmpDir],
      baseEnv,
    );

    expect(r.code).toBe(0);
    // One failed attempt + one successful attempt.
    expect(server.requests.length).toBe(2);

    const recs = parseHeadlessStream(r.stdout);
    const retries = recs.filter((x) => x.type === "retry");
    expect(retries.length).toBe(1);
    if (retries[0]?.type === "retry") {
      expect(retries[0].reasonClass).toBe("server_error");
      expect(retries[0].attempt).toBe(2);
      expect(retries[0].maxAttempts).toBe(3);
      expect(retries[0].delayMs).toBeGreaterThan(0);
      expect(retries[0].delayMs).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    }

    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") {
      expect(complete.ok).toBe(true);
      expect(complete.reason).toBe("completed");
    }

    // The run summary reports exactly one retry.
    const summary = recs.find((x) => x.type === "summary");
    if (summary?.type === "summary") {
      expect(summary.summary.retries).toBe(1);
    }
  });

  it("classifies a 429 as rate_limited and retries it", async () => {
    server.setResponses([
      { failWith: { status: 429, retryAfter: "1" } },
      { type: "text", content: "ok" },
    ]);

    const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(0);
    expect(server.requests.length).toBe(2);

    const recs = parseHeadlessStream(r.stdout);
    const retry = recs.find((x) => x.type === "retry");
    expect(retry).toBeDefined();
    if (retry?.type === "retry") {
      expect(retry.reasonClass).toBe("rate_limited");
      expect(retry.delayMs).toBeGreaterThan(0);
      expect(retry.delayMs).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    }
  });

  it("exhausts the bounded retry budget then fails as provider_error", async () => {
    // Three persistent failures: attempt 1 and 2 are retried, attempt 3 exhausts
    // the budget (RETRY_MAX_ATTEMPTS = 3) and surfaces as a provider error.
    server.setResponses([
      { failWith: { status: 503 } },
      { failWith: { status: 503 } },
      { failWith: { status: 503 } },
    ]);

    const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(1);
    // Exactly the bounded number of attempts; no unbounded hammering.
    expect(server.requests.length).toBe(3);

    const recs = parseHeadlessStream(r.stdout);
    const retries = recs.filter((x) => x.type === "retry");
    expect(retries.length).toBe(2);

    const error = recs.find((x) => x.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") expect(error.stage).toBe("provider");

    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") {
      expect(complete.ok).toBe(false);
      expect(complete.reason).toBe("provider_error");
    }
  });

  it("does not retry a non-retryable 400", async () => {
    server.setResponses([
      { failWith: { status: 400 } },
      { type: "text", content: "should not be reached" },
    ]);

    const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(1);
    // No retry: a single request, then immediate failure.
    expect(server.requests.length).toBe(1);

    const recs = parseHeadlessStream(r.stdout);
    expect(recs.filter((x) => x.type === "retry").length).toBe(0);

    const complete = recs.find((x) => x.type === "complete");
    if (complete?.type === "complete") {
      expect(complete.ok).toBe(false);
      expect(complete.reason).toBe("provider_error");
    }
  });

  it("reports the retry on stderr in text mode", async () => {
    server.setResponses([{ failWith: { status: 503 } }, { type: "text", content: "recovered" }]);

    const r = await runCli(["-p", "hello", "--workspace", tmpDir], baseEnv);

    expect(server.requests.length).toBe(2);
    expect(r.stderr).toContain("Provider retry 2/3 after server_error");
  });
});
