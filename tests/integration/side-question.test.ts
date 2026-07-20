import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
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

describe("Integration: side question (--side-question)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sideq-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sideq-sess-"));
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
    for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
  });

  function sessionsHome(): string {
    return path.join(sessionDir, ".oh-my-cli", "sessions");
  }

  function sessionIds(): string[] {
    if (!fs.existsSync(sessionsHome())) return [];
    return fs
      .readdirSync(sessionsHome())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  // A full snapshot of every file under the sessions dir (name -> bytes), so an
  // isolation assertion covers the transcript and every sidecar at once.
  function snapshotSessionsDir(): Record<string, string> {
    const out: Record<string, string> = {};
    const dir = sessionsHome();
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).sort()) {
      out[f] = fs.readFileSync(path.join(dir, f), "utf8");
    }
    return out;
  }

  // Run one main-task turn so a session exists with real context to snapshot.
  async function seedSession(): Promise<string> {
    server.setResponses([{ type: "text", content: "MAIN ANSWER" }]);
    const r = await runCli(
      ["-p", "remember the project uses vitest", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const ids = sessionIds();
    expect(ids.length).toBe(1);
    return ids[0];
  }

  it("answers without mutating the source session, goal, or workspace (isolation)", async () => {
    const id = await seedSession();
    const before = snapshotSessionsDir();
    const workspaceBefore = fs.readdirSync(tmpDir).sort();

    server.setResponse({ type: "text", content: "SIDE ANSWER" });
    const r = await runCli(
      ["--side-question", "what test runner does this project use?", "--session", id],
      baseEnv,
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("SIDE ANSWER");
    // The boundary summary explains the read-only scope on stderr.
    expect(r.stderr).toContain("read-only");
    expect(r.stderr).toContain("Tools and workspace changes are disabled");

    // The session dir (transcript + every sidecar) is byte-identical.
    expect(snapshotSessionsDir()).toEqual(before);
    // No new session was created by the side question.
    expect(sessionIds()).toEqual([id]);
    // The workspace is untouched.
    expect(fs.readdirSync(tmpDir).sort()).toEqual(workspaceBefore);
  });

  it("sends no tool schemas and includes the boundary note and question", async () => {
    const id = await seedSession();
    server.requests.length = 0;
    server.setResponse({ type: "text", content: "ok" });
    await runCli(["--side-question", "the question", "--session", id], baseEnv);

    expect(server.requests.length).toBe(1);
    const body = server.requests[0].body as {
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.tools).toBeUndefined();
    const last = body.messages[body.messages.length - 1];
    expect(last).toEqual({ role: "user", content: "the question" });
    const boundary = body.messages[body.messages.length - 2];
    expect(boundary.role).toBe("system");
    expect(boundary.content).toMatch(/side question/i);
    expect(boundary.content).toMatch(/Do not request or run any tool/i);
  });

  it("emits a versioned JSON result with --output json", async () => {
    const id = await seedSession();
    server.setResponse({ type: "text", content: "JSON ANSWER" });
    const r = await runCli(
      ["--side-question", "q?", "--session", id, "--output", "json"],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.side-question");
    expect(parsed.v).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe("completed");
    expect(parsed.answer).toBe("JSON ANSWER");
    expect(parsed.context.sourceMessageCount).toBeGreaterThan(0);
  });

  it("works with no --session (empty context)", async () => {
    server.setResponse({ type: "text", content: "FRESH ANSWER" });
    const r = await runCli(["--side-question", "a standalone question"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FRESH ANSWER");
    expect(r.stderr).toContain("read-only");
    // No session is created for a context-free side question.
    expect(sessionIds()).toEqual([]);
  });

  it("fails closed (exit 2) when the named session does not exist", async () => {
    const r = await runCli(
      ["--side-question", "q?", "--session", "does-not-exist"],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not found");
  });
});
