import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseHeadlessStream, terminalRecord } from "../../src/headless-protocol.js";
import { RETRY_MAX_ATTEMPTS } from "../../src/provider.js";

type Spec = "empty" | { text: string };

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

// A provider that serves a queue of completions: "empty" yields only a usage
// chunk (no assistant text or tool call); {text} streams a normal answer. Every
// completion carries a deterministic usage chunk.
function startProviderServer(initial: Spec[]): Promise<{ url: string; requests: unknown[]; close: () => Promise<void> }> {
  const requests: unknown[] = [];
  let queue = [...initial];
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { requests.push(JSON.parse(body)); } catch { requests.push(body); }
        const spec: Spec = queue.length > 0 ? queue.shift()! : "empty";
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        const id = "chatcmpl-empty";
        if (typeof spec === "object") {
          for (const char of spec.text) {
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: char }, finish_reason: null }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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
        requests,
        close: () => new Promise<void>((res2, rej) => server.close((e) => (e ? rej(e) : res2()))),
      });
    });
  });
}

describe("Integration: bounded recovery from empty completions (#244)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-empty-int-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-empty-int-sess-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  function envFor(url: string): Record<string, string> {
    return { OPENAI_API_KEY: "fake-key", OPENAI_BASE_URL: url, OPENAI_MODEL: "fake-model", HOME: sessionDir };
  }

  it("recovers from an empty completion then a valid answer: one empty_response retry, success", async () => {
    const server = await startProviderServer(["empty", { text: "real answer" }]);
    try {
      const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], envFor(server.url));
      expect(r.code).toBe(0);
      // The empty first attempt and the valid second attempt both hit the provider.
      expect(server.requests.length).toBe(2);

      const recs = parseHeadlessStream(r.stdout);
      const retryIdx = recs.findIndex((x) => x.type === "retry");
      const assistantIdx = recs.findIndex((x) => x.type === "assistant");
      expect(retryIdx).toBeGreaterThanOrEqual(0);
      expect(assistantIdx).toBeGreaterThanOrEqual(0);

      const retry = recs[retryIdx];
      if (retry.type !== "retry") throw new Error("expected a retry record");
      expect(retry.reasonClass).toBe("empty_response");
      expect(retry.maxAttempts).toBe(RETRY_MAX_ATTEMPTS);

      const assistant = recs[assistantIdx];
      if (assistant.type !== "assistant") throw new Error("expected an assistant record");
      expect(assistant.text).toContain("real answer");
      expect(assistant.interrupted).toBe(false);
      expect(assistant.final).toBe(true);

      // The retry precedes the recovered assistant record.
      expect(retryIdx).toBeLessThan(assistantIdx);

      const term = terminalRecord(recs);
      expect(term!.ok).toBe(true);
      if (term && term.type === "complete") expect(term.exitCode).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("terminates non-zero on persistent empty completions with no assistant record", async () => {
    const server = await startProviderServer(["empty"]);
    try {
      const r = await runCli(["-p", "hello", "--output", "json", "--workspace", tmpDir], envFor(server.url));
      expect(r.code).toBe(1);
      // The provider is called exactly RETRY_MAX_ATTEMPTS times (bounded).
      expect(server.requests.length).toBe(RETRY_MAX_ATTEMPTS);

      const recs = parseHeadlessStream(r.stdout);
      const emptyRetries = recs.filter((x) => x.type === "retry" && x.reasonClass === "empty_response");
      expect(emptyRetries.length).toBe(RETRY_MAX_ATTEMPTS - 1);
      // No assistant record (empty or otherwise) is emitted.
      expect(recs.some((x) => x.type === "assistant")).toBe(false);

      const term = terminalRecord(recs);
      expect(term!.ok).toBe(false);
      if (term && term.type === "complete") {
        expect(term.reason).toBe("empty_response");
        expect(term.exitCode).toBe(1);
      }
    } finally {
      await server.close();
    }
  });
});
