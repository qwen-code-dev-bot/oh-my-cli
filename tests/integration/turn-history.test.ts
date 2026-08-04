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

describe("Integration: turn-change provenance (--turn-history, Issue #568)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-568-ith-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-568-ith-sess-"));
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

  function singleSessionId(): string {
    const ids = fs.readdirSync(sessionsHome()).filter((f) => f.endsWith(".jsonl"));
    expect(ids.length).toBe(1);
    return ids[0].slice(0, -".jsonl".length);
  }

  // One completed turn writing two files in a batch (one checkpoint, two
  // created-file changes).
  async function seedWriteTurn(): Promise<string> {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [
          { id: "w1", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "alpha\nbeta\n" }) },
          { id: "w2", name: "write", arguments: JSON.stringify({ path: "b.txt", content: "gamma\n" }) },
        ],
      },
      { type: "text", content: "DONE_MARK" },
    ]);
    const r = await runCli(
      ["-p", "write the files", "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    return singleSessionId();
  }

  it("renders per-turn provenance for a session with a file-writing turn", async () => {
    const id = await seedWriteTurn();
    const r = await runCli(["--turn-history", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Turn history");
    expect(r.stdout).toContain("Turn 0");
    // Not a git workspace: the captured head is explicit, never invented.
    expect(r.stdout).toContain("no git head");
    expect(r.stdout).toContain("[created]  a.txt (+2 lines)");
    expect(r.stdout).toContain("[created]  b.txt (+1 lines)");
    expect(r.stdout).toContain("Undo state: none");
    // Provenance only — never file content.
    expect(r.stdout).not.toContain("alpha");
    expect(r.stdout).not.toContain("gamma");
    // No ANSI in a headless read.
    expect(r.stdout).not.toMatch(/\x1b\[/);
  });

  it("emits a versioned JSON record and is deterministic across reads", async () => {
    const id = await seedWriteTurn();
    const a = await runCli(["--turn-history", id, "--output", "json"], baseEnv);
    const b = await runCli(["--turn-history", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const parsed = JSON.parse(a.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.turn-history");
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.logState).toBe("ok");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].head).toBeNull();
    expect(parsed.entries[0].files.map((f: { path: string; action: string }) => `${f.action}:${f.path}`)).toEqual([
      "created:a.txt",
      "created:b.txt",
    ]);
    expect(parsed.entries[0].digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the text view too", async () => {
    const id = await seedWriteTurn();
    const a = await runCli(["--turn-history", id], baseEnv);
    const b = await runCli(["--turn-history", id], baseEnv);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("is strictly read-only: the turn log and session are byte-identical after reads", async () => {
    const id = await seedWriteTurn();
    const turnLog = path.join(sessionsHome(), `${id}.turn.json`);
    const session = path.join(sessionsHome(), `${id}.jsonl`);
    const before = fs.readFileSync(turnLog, "utf8") + fs.readFileSync(session, "utf8");
    const text = await runCli(["--turn-history", id], baseEnv);
    const json = await runCli(["--turn-history", id, "--output", "json"], baseEnv);
    expect(text.code).toBe(0);
    expect(json.code).toBe(0);
    expect(fs.readFileSync(turnLog, "utf8") + fs.readFileSync(session, "utf8")).toBe(before);
  });

  it("shows a checkpoint without file changes for a text-only turn", async () => {
    server.setResponses([{ type: "text", content: "just an answer" }]);
    const r0 = await runCli(["-p", "hello", "--approval-mode", "yolo", "--workspace", tmpDir], baseEnv);
    expect(r0.code).toBe(0);
    const id = singleSessionId();
    const r = await runCli(["--turn-history", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Turn 0");
    expect(r.stdout).toContain("(no file changes)");
  });

  it("fails closed (exit 2) for an unknown session and a bad format", async () => {
    const missing = await runCli(["--turn-history", "no-such-session"], baseEnv);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Error");

    const id = await seedWriteTurn();
    const bad = await runCli(["--turn-history", id, "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid output format");
  });
});
