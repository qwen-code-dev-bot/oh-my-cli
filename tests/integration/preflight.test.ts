import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";

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

describe("Integration: provider connectivity preflight", () => {
  let server: FakeServer;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-preflight-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("reports success with valid provider", async () => {
    server.setResponse({ type: "text", content: "ok" });

    const result = await runCli(["--preflight"], baseEnv);
    expect(result.stdout).toContain("Provider connected");
    expect(result.stdout).toContain("fake-model");
    expect(result.code).toBe(0);
  });

  it("classifies authentication failure (401)", async () => {
    const authServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid", type: "invalid_request_error" } }));
      });
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const addr = authServer.address() as AddressInfo;
    const authUrl = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const result = await runCli(["--preflight"], {
        ...baseEnv,
        OPENAI_BASE_URL: authUrl,
        OPENAI_API_KEY: "wrong-key",
      });
      expect(result.stdout).toContain("auth_rejected");
      expect(result.stdout).not.toContain("wrong-key");
      expect(result.code).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()));
    }
  });

  it("classifies network failure (connection refused)", async () => {
    const result = await runCli(["--preflight"], {
      ...baseEnv,
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    });
    expect(result.stdout).toContain("network_failure");
    expect(result.code).not.toBe(0);
  });

  it("exits non-zero on preflight failure in headless use", async () => {
    const result = await runCli(["--preflight"], {
      ...baseEnv,
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    });
    expect(result.code).toBe(1);
  });

  it("never reveals credentials in output", async () => {
    // Use a value that does not resemble a real API key format
    const fixtureValue = "fixture-nonsecret-value-12345";
    const result = await runCli(["--preflight"], {
      ...baseEnv,
      OPENAI_API_KEY: fixtureValue,
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    });
    expect(result.stdout).not.toContain(fixtureValue);
    expect(result.stderr).not.toContain(fixtureValue);
  });

  it("shows --preflight in help", async () => {
    const result = await runCli(["--help"], baseEnv);
    expect(result.stdout).toContain("--preflight");
  });
});
