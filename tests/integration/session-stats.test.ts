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

describe("Integration: session stats (--session-stats)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-stats-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-stats-sess-"));
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

  // Seed a session that made one tool call (shell) and then answered, so the
  // stats view has a tool-call breakdown to aggregate end-to-end.
  async function seedSession(): Promise<string> {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_1", name: "shell", arguments: JSON.stringify({ command: "echo hi" }) }],
      },
      { type: "text", content: "MAIN ANSWER" },
    ]);
    const r = await runCli(
      ["-p", "inspect the build", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const ids = sessionIds();
    expect(ids.length).toBe(1);
    return ids[0];
  }

  it("renders a deterministic, no-fabrication text view for a seeded session", async () => {
    const id = await seedSession();
    const r = await runCli(["--session-stats", id], baseEnv);

    expect(r.code).toBe(0);
    // No ANSI in a headless read.
    expect(r.stdout).not.toMatch(/\x1b\[/);
    // Every section is present, with redacted provenance.
    expect(r.stdout).toContain("model fake-model");
    expect(r.stdout).toContain("Session activity");
    expect(r.stdout).toContain("Context");
    expect(r.stdout).toContain("Model activity (this session)");
    expect(r.stdout).toContain("Tool outcomes");
    expect(r.stdout).toContain("Timing");
    // The tool call is counted by name from the canonical log.
    expect(r.stdout).toContain("shell×1");
    // A headless read has no live runtime, so model activity / failures /
    // timing read n/a rather than a fabricated zero.
    expect(r.stdout).toMatch(/requests\s+n\/a/);
    expect(r.stdout).toMatch(/tool failures\s+n\/a/);
    expect(r.stdout).toMatch(/active time\s+n\/a/);
    // The context size is an estimate, never an exact token count.
    expect(r.stdout).toContain("(est.)");
  });

  it("emits a versioned JSON document for automation", async () => {
    const id = await seedSession();
    const r = await runCli(["--session-stats", id, "--output", "json"], baseEnv);

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.stats");
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.provenance.model).toBe("fake-model");
    // Activity is deterministic from the canonical log: system, user,
    // assistant(+tool_calls), tool result, final assistant. The system prompt is
    // a persisted message but not a user/assistant turn.
    expect(parsed.activity.messages).toBe(5);
    expect(parsed.activity.userTurns).toBe(1);
    expect(parsed.activity.assistantTurns).toBe(2);
    // The tool call is counted by name from the log, end-to-end.
    expect(parsed.tools.calls.total).toBe(1);
    expect(parsed.tools.calls.byName).toEqual({ shell: 1 });
    // Context size is always an estimate; model activity is unavailable headless.
    expect(parsed.context.tokens.kind).toBe("estimate");
    expect(parsed.model.requests.kind).toBe("unavailable");
    expect(parsed.model.estimatedCostUsd.kind).toBe("unavailable");
    expect(parsed.timing.elapsedMs.kind).toBe("unavailable");
  });

  it("is deterministic: repeated reads are byte-identical", async () => {
    const id = await seedSession();
    const a = await runCli(["--session-stats", id, "--output", "json"], baseEnv);
    const b = await runCli(["--session-stats", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("reads without mutating the session or creating a new one (isolation)", async () => {
    const id = await seedSession();
    const before = snapshotSessionsDir();

    const r = await runCli(["--session-stats", id], baseEnv);
    expect(r.code).toBe(0);

    // The session dir (transcript + every sidecar) is byte-identical.
    expect(snapshotSessionsDir()).toEqual(before);
    // No new session was created by the read.
    expect(sessionIds()).toEqual([id]);
  });

  it("fails closed (exit 2) when the session does not exist", async () => {
    const r = await runCli(["--session-stats", "does-not-exist"], baseEnv);
    expect(r.code).toBe(2);
    // Id-or-name targeting (#536): shared resolution reason.
    expect(r.stderr).toContain("no session named");
  });

  it("rejects an invalid --output format (exit 2)", async () => {
    const id = await seedSession();
    const r = await runCli(["--session-stats", id, "--output", "yaml"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid output format");
  });

  it("surfaces tool-call cancellations from the transcript (Issue #550)", async () => {
    const { CANCELLED_TOOL_CONTENT } = await import("../../src/agent.js");
    // Seed a transcript containing one executed call and two cancelled
    // placeholders, as a cancelled batch persists it.
    fs.mkdirSync(sessionsHome(), { recursive: true });
    const id = "cancelled-batch";
    const lines = [
      JSON.stringify({ meta: true, model: "fake-model", workspace: tmpDir, createdAt: 1 }),
      JSON.stringify({ role: "user", content: "do the work" }),
      JSON.stringify({
        role: "assistant",
        content: "working",
        tool_calls: [
          { id: "k1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "k2", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      }),
      JSON.stringify({ role: "tool", content: "real result", tool_call_id: "k1" }),
      JSON.stringify({ role: "tool", content: CANCELLED_TOOL_CONTENT, tool_call_id: "k2" }),
    ];
    fs.writeFileSync(path.join(sessionsHome(), `${id}.jsonl`), lines.join("\n") + "\n");

    const text = await runCli(["--session-stats", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/cancelled\s+1/);
    expect(text.stdout).toContain("shell×1");

    const json = await runCli(["--session-stats", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.tools.cancellations.total).toBe(1);
    expect(parsed.tools.cancellations.byName).toEqual({ shell: 1 });
    expect(parsed.tools.calls.total).toBe(2);
  });
});
