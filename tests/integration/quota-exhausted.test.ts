import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { parseHeadlessStream } from "../../src/headless-protocol.js";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
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

// A local provider that always fails with a configured status + error body, so
// the SDK throws an APIError carrying bounded structured code/type fields.
function startErrorServer(getResponse: () => { status: number; body: unknown }): Promise<{
  url: string;
  requests: unknown[];
  close: () => Promise<void>;
}> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push(body); }
      const r = getResponse();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        requests,
        close: () => new Promise<void>((res2, rej) => server.close((e) => (e ? rej(e) : res2()))),
      });
    });
  });
}

const QUOTA_BODY = {
  error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" },
};
const RATE_LIMIT_BODY = { error: { code: "rate_limited", message: "slow down" } };

describe("Integration: quota-exhausted classification (#247)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-quota-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-quota-sess-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  function envFor(url: string): Record<string, string> {
    return { OPENAI_API_KEY: "fake-key", OPENAI_BASE_URL: url, OPENAI_MODEL: "fake-model", HOME: sessionDir };
  }

  it("headless agent: classifies exhausted quota, surfaces guidance, does not retry, exits non-zero", async () => {
    const server = await startErrorServer(() => ({ status: 429, body: QUOTA_BODY }));
    try {
      const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], envFor(server.url));
      expect(r.code).toBe(1);

      const recs = parseHeadlessStream(r.stdout);
      // No transient retry for an exhausted quota.
      expect(recs.filter((x) => x.type === "retry").length).toBe(0);
      // Exactly one request reached the provider (no retry).
      expect(server.requests.length).toBe(1);
      // The surfaced error carries the secret-safe quota guidance.
      const err = recs.find((x) => x.type === "error");
      expect(err).toBeDefined();
      if (err?.type !== "error") throw new Error("expected an error record");
      expect(err.message.toLowerCase()).toContain("quota");
      expect(err.message).toContain("not be retried automatically");
      // No raw provider message/account/project/credential detail leaks.
      expect(err.message).not.toContain("You exceeded your current quota");
      // A terminal failure record with non-zero exit.
      const completes = recs.filter((x) => x.type === "complete");
      expect(completes.length).toBe(1);
      if (completes[0].type !== "complete") throw new Error("expected a complete record");
      expect(completes[0].ok).toBe(false);
      expect(completes[0].exitCode).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("headless agent: a bare 429 stays a transient rate limit and is retried", async () => {
    const server = await startErrorServer(() => ({ status: 429, body: RATE_LIMIT_BODY }));
    try {
      const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], envFor(server.url));
      expect(r.code).toBe(1);
      const recs = parseHeadlessStream(r.stdout);
      // Transient rate limiting keeps the bounded retry behavior.
      const retries = recs.filter((x) => x.type === "retry");
      expect(retries.length).toBeGreaterThan(0);
      if (retries[0].type !== "retry") throw new Error("expected a retry record");
      expect(retries[0].reasonClass).toBe("rate_limited");
      // More than one request reached the provider (it retried).
      expect(server.requests.length).toBeGreaterThan(1);
    } finally {
      await server.close();
    }
  });

  it("direct invocation: reports the quota-exhausted outcome", async () => {
    const server = await startErrorServer(() => ({ status: 429, body: QUOTA_BODY }));
    try {
      // A provider contract resolving to the error server so the invocation
      // passes the readiness gate and actually issues the bounded request.
      const home = fs.mkdtempSync(path.join(tmpDir, "home-"));
      fs.mkdirSync(path.join(home, ".oh-my-cli"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".oh-my-cli", "settings.json"),
        JSON.stringify({
          providers: {
            contractVersion: 1,
            entries: [{ id: "p", baseUrl: server.url, model: "fake-model", apiKeyEnv: "TEST_PROVIDER_KEY" }],
          },
        }),
      );
      const r = await runCli(
        ["--invoke-provider", "--approval-mode", "yolo", "--provider-prompt", "hi", "--workspace", tmpDir, "--output", "json"],
        { HOME: home, TEST_PROVIDER_KEY: "sk-test" },
      );
      expect(r.code).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.outcome).toBe("quota-exhausted");
      expect(report.status).toBe(429);
      expect(String(report.reason).toLowerCase()).toContain("quota");
    } finally {
      await server.close();
    }
  });
});
