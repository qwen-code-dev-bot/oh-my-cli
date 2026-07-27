import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseHeadlessStream, terminalRecord } from "../../src/headless-protocol.js";

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

// A provider that streams a short answer and then aborts the connection
// mid-stream, simulating a network/API failure after useful output was emitted.
function startMidStreamFailureServer(text: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        const id = "chatcmpl-partial";
        for (const char of text) {
          const chunk = {
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: char }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        // Let the text flush, then reset the connection so the client sees a
        // failure AFTER output started (the no-re-after-output path).
        setTimeout(() => {
          res.socket?.destroy();
        }, 30);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

describe("Integration: preserve partial assistant output on mid-stream failure (#243)", () => {
  let server: { url: string; close: () => Promise<void> };
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await startMidStreamFailureServer("Partial answer");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-partial-int-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-partial-int-sess-"));
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

  it("emits the partial assistant record (interrupted) before the terminal failure, exiting non-zero", async () => {
    const r = await runCli(["-p", "tell me", "--output", "json", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(1);
    const recs = parseHeadlessStream(r.stdout);

    const assistantIdx = recs.findIndex((x) => x.type === "assistant");
    const errorIdx = recs.findIndex((x) => x.type === "error");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThanOrEqual(0);

    const assistant = recs[assistantIdx];
    if (assistant.type !== "assistant") throw new Error("expected an assistant record");
    expect(assistant.interrupted).toBe(true);
    expect(assistant.final).toBe(false);
    expect(assistant.text).toContain("Partial answer");

    // The partial record precedes the terminal failure record.
    expect(assistantIdx).toBeLessThan(errorIdx);

    const term = terminalRecord(recs);
    expect(term).not.toBeNull();
    expect(term!.ok).toBe(false);
    if (term && term.type === "complete") {
      expect(term.reason).toBe("provider_error");
      expect(term.exitCode).toBe(1);
      expect(term.exitCode).toBe(r.code);
    }
  });

  it("keeps the partial text visible with a non-color-only interruption indicator in text mode", async () => {
    const r = await runCli(["-p", "tell me", "--workspace", tmpDir], baseEnv);

    expect(r.code).toBe(1);
    // The emitted text stays visible on stdout.
    expect(r.stdout).toContain("Partial answer");
    // A plain-text interruption indicator is shown (stderr), not color-only.
    expect(r.stderr).toContain("[interrupted");
  });
});
