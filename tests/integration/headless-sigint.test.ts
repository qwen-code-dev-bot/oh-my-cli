import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// A headless run where the first Ctrl+C arrives mid-batch: the run must stop
// at the next cancel boundary with a truthful terminal record (Issue #552),
// never a silent mid-run death and never a completed-looking transcript.

function cliPath(): string {
  return path.resolve(import.meta.dirname, "../../dist/index.js");
}

interface RecordLine {
  type: string;
  [key: string]: unknown;
}

// Spawn a -p run and watch the NDJSON stream; when `signalOn` returns true for
// a record, send SIGINT to the child exactly once. Resolves with the full
// record list, stderr, and the exit code.
function runHeadless(opts: {
  args: string[];
  env: Record<string, string | undefined>;
  signalOn?: (rec: RecordLine) => boolean;
  timeoutMs?: number;
}): Promise<{ records: RecordLine[]; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn("node", [cliPath(), ...opts.args], {
      env: { ...process.env, ...opts.env },
    });
    const records: RecordLine[] = [];
    let buffer = "";
    let stderr = "";
    let signalled = false;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`headless run timed out after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);
    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let rec: RecordLine;
        try {
          rec = JSON.parse(line) as RecordLine;
        } catch {
          continue; // tolerate non-protocol noise; assertions catch omissions
        }
        records.push(rec);
        if (!signalled && opts.signalOn?.(rec)) {
          signalled = true;
          proc.kill("SIGINT");
        }
      }
    });
    proc.stderr!.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ records, stderr, code });
    });
    proc.on("error", reject);
  });
}

describe("Integration: cooperative SIGINT cancellation of headless runs (Issue #552)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sigint-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sigint-sess-"));
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "note\n");
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
    fs.rmSync(path.join(sessionDir, ".oh-my-cli"), { recursive: true, force: true });
    // A two-call batch: the first tool blocks long enough for the SIGINT to
    // land mid-batch; the second must never execute once the cancel is set.
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [
          { id: "c1", name: "shell", arguments: JSON.stringify({ command: "sleep 3" }) },
          { id: "c2", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
        ],
      },
      { type: "text", content: "done" },
    ]);
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  it("stops at the next boundary with a truthful terminal record and exit 130", async () => {
    const { records, stderr, code } = await runHeadless({
      args: ["-p", "run the batch", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      env: baseEnv,
      signalOn: (rec) => rec.type === "tool_start" && rec.name === "shell",
    });

    expect(code).toBe(130);
    // One bounded interruption notice on stderr; the protocol stream stays clean.
    expect(stderr).toContain("cancelling at the next safe boundary");

    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(2);
    // The in-flight tool ran to completion; the pending one never ran.
    expect(results[0]).toMatchObject({ id: "c1", ok: true, state: "succeeded" });
    expect(results[1]).toMatchObject({ id: "c2", ok: false, state: "cancelled" });

    // Exactly one provider round: the cancel stopped the loop before round 2.
    expect(server.requests.length).toBe(1);

    // Truthful terminal record, and nothing after it.
    const terminal = records.filter((r) => r.type === "complete");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ ok: false, exitCode: 130, reason: "cancelled" });
    expect(records[records.length - 1].type).toBe("complete");
  });

  it("keeps the transcript resume-valid: one tool message per call id", async () => {
    const { CANCELLED_TOOL_CONTENT } = await import("../../src/agent.js");
    const { code } = await runHeadless({
      args: ["-p", "run the batch", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      env: baseEnv,
      signalOn: (rec) => rec.type === "tool_start" && rec.name === "shell",
    });
    expect(code).toBe(130);

    const files = fs.readdirSync(sessionsHome()).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    const lines = fs
      .readFileSync(path.join(sessionsHome(), files[0]), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const assistant = lines.find((l) => Array.isArray(l.tool_calls));
    expect(assistant).toBeDefined();
    const ids = (assistant!.tool_calls as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(["c1", "c2"]);
    const toolMsgs = lines.filter((l) => l.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMsgs[0].content).not.toBe(CANCELLED_TOOL_CONTENT);
    expect(toolMsgs[1].content).toBe(CANCELLED_TOOL_CONTENT);
  });

  it("text mode cancels with one bounded notice and exit 130", async () => {
    // Text mode has no protocol records to watch, so SIGINT on a fixed delay
    // with a wide margin: the first tool sleeps 10s and the signal lands 3.5s
    // in — comfortably after boot on slow runners, well inside the window.
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [
          { id: "t1", name: "shell", arguments: JSON.stringify({ command: "sleep 10" }) },
          { id: "t2", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
        ],
      },
      { type: "text", content: "done" },
    ]);
    const timed = await new Promise<{ stderr: string; code: number | null }>((resolve, reject) => {
      const proc = spawn(
        "node",
        [cliPath(), "-p", "run the batch", "--approval-mode", "yolo", "--workspace", tmpDir],
        { env: { ...process.env, ...baseEnv } },
      );
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("text-mode cancel timed out"));
      }, 30_000);
      const sigintTimer = setTimeout(() => proc.kill("SIGINT"), 3_500);
      proc.stderr!.on("data", (d) => {
        stderr += d;
      });
      proc.stdout!.resume();
      proc.on("close", (c) => {
        clearTimeout(timer);
        clearTimeout(sigintTimer);
        resolve({ stderr, code: c });
      });
      proc.on("error", reject);
    });
    expect(timed.code).toBe(130);
    expect(timed.stderr).toContain("cancelling at the next safe boundary");
    expect(server.requests.length).toBe(1);
  });

  it("without a signal the run completes unchanged (exit 0, both tools succeeded)", async () => {
    const { records, code } = await runHeadless({
      args: ["-p", "run the batch", "--output", "json", "--approval-mode", "yolo", "--workspace", tmpDir],
      env: baseEnv,
    });

    expect(code).toBe(0);
    expect(server.requests.length).toBe(2);
    const results = records.filter((r) => r.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "c1", ok: true, state: "succeeded" });
    expect(results[1]).toMatchObject({ id: "c2", ok: true, state: "succeeded" });
    const terminal = records.filter((r) => r.type === "complete");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ ok: true, exitCode: 0, reason: "completed" });
  });
});
