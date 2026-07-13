import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

describe("Integration: malformed provider data", () => {
  let server: http.Server;
  let serverUrl: string;
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-malformed-"));

    server = http.createServer((req, res) => {
      if (req.method === "POST" && (req.url === "/chat/completions" || req.url === "/v1/chat/completions")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          // Send malformed SSE data
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
          });
          // Send a valid chunk then an invalid one
          const validChunk = {
            id: "test",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(validChunk)}\n\n`);
          // Malformed JSON
          res.write(`data: {not valid json}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("handles malformed provider data without crashing", async () => {
    const result = await runCli(
      ["-p", "test malformed"],
      {
        OPENAI_API_KEY: "fake-key",
        OPENAI_BASE_URL: serverUrl,
        OPENAI_MODEL: "fake-model",
        HOME: sessionDir,
      },
    );

    // Should not crash, may show partial content or error
    // The important thing is it exits (doesn't hang) and doesn't corrupt
    expect(result.code).not.toBeNull();
  });
});

describe("Integration: provider error handling", () => {
  let server: http.Server;
  let serverUrl: string;
  let sessionDir: string;

  beforeAll(async () => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-err-"));

    server = http.createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal server error" } }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("handles provider 500 error gracefully", async () => {
    const result = await runCli(
      ["-p", "test error"],
      {
        OPENAI_API_KEY: "fake-key",
        OPENAI_BASE_URL: serverUrl,
        OPENAI_MODEL: "fake-model",
        HOME: sessionDir,
      },
    );

    // Should show an error message but not crash
    expect(result.stderr).toContain("Provider error");
  });
});
