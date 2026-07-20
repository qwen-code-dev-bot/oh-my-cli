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

describe("Integration: turn undo/redo (--undo-turn / --redo-turn)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-turn-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-turn-sess-"));
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
    // Each test starts with no sessions and a clean workspace so ids and
    // pre-images are unambiguous.
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

  function transcript(id: string): string {
    return fs.readFileSync(path.join(sessionsHome(), `${id}.jsonl`), "utf8");
  }

  // Run one completed turn that writes `file` = `content` and then answers.
  // Returns the session id; asserts a checkpoint sidecar was captured.
  async function runWriteTurn(file: string, content: string): Promise<string> {
    server.setResponses([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call_w", name: "write", arguments: JSON.stringify({ path: file, content }) }],
      },
      { type: "text", content: "DONE_MARK" },
    ]);
    const r = await runCli(
      ["-p", `Write ${file}`, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(r.code).toBe(0);
    const id = singleSessionId();
    expect(fs.existsSync(path.join(sessionsHome(), `${id}.turn.json`))).toBe(true);
    return id;
  }

  it("captures a checkpoint and previews undo without changing anything (--dry-run)", async () => {
    const id = await runWriteTurn("note.txt", "v1");
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("v1");

    const dry = await runCli(["--undo-turn", id, "--dry-run"], baseEnv);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("Undo turn #0");
    expect(dry.stdout).toContain("note.txt");
    // Preview only: file and transcript untouched.
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("v1");
  });

  it("undo deletes a turn-created file and trims the transcript; redo restores both", async () => {
    const id = await runWriteTurn("note.txt", "v1");
    expect(transcript(id)).toContain("DONE_MARK");

    const undo = await runCli(["--undo-turn", id], baseEnv);
    expect(undo.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "note.txt"))).toBe(false);
    expect(transcript(id)).not.toContain("DONE_MARK");

    // Idempotent: re-undoing an already-undone turn fails closed (exit 2).
    const again = await runCli(["--undo-turn", id], baseEnv);
    expect(again.code).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "note.txt"))).toBe(false);

    const redo = await runCli(["--redo-turn", id], baseEnv);
    expect(redo.code).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("v1");
    expect(transcript(id)).toContain("DONE_MARK");
  });

  it("restores a pre-existing file's content instead of deleting it (dirty-before-turn)", async () => {
    // The file already holds user content before the turn overwrites it.
    fs.writeFileSync(path.join(tmpDir, "note.txt"), "user-original");
    const id = await runWriteTurn("note.txt", "agent-version");
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("agent-version");

    const undo = await runCli(["--undo-turn", id], baseEnv);
    expect(undo.code).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("user-original");
  });

  it("fails closed (exit 2) when the workspace diverged, leaving everything unchanged", async () => {
    const id = await runWriteTurn("note.txt", "v1");
    const transcriptBefore = transcript(id);
    // Externally modify the turn-owned file after the turn.
    fs.writeFileSync(path.join(tmpDir, "note.txt"), "external-change");

    const undo = await runCli(["--undo-turn", id], baseEnv);
    expect(undo.code).toBe(2);
    expect(undo.stderr).toMatch(/diverged/);
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("external-change");
    expect(transcript(id)).toBe(transcriptBefore);
  });

  it("emits a structured JSON preview with --output json", async () => {
    const id = await runWriteTurn("note.txt", "v1");
    const r = await runCli(["--undo-turn", id, "--dry-run", "--output", "json"], baseEnv);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.op).toBe("undo");
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.files.some((f: { path: string }) => f.path === "note.txt")).toBe(true);
  });

  it("exits 2 for a missing session", async () => {
    const r = await runCli(["--undo-turn", "no-such-id"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no such session");
  });
});
