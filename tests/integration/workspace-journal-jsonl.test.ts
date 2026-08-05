import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { WORKSPACE_JOURNAL_SCHEMA, WORKSPACE_JOURNAL_VERSION } from "../../src/workspace-journal.js";

const CREATED_AT = 1_700_000_000_000;

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

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for jsonl output");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.length > 0);
}

describe("Integration: workspace journal jsonl follow (--output jsonl, Issue #686)", () => {
  let homeDir: string;
  let wsDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  let sessionId: string;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function spawnFollow(args: string[]): {
    proc: ChildProcessWithoutNullStreams;
    stdout: () => string;
    stderr: () => string;
    exitCode: () => Promise<number | null>;
  } {
    const cliPath = path.resolve(import.meta.dirname, "../../dist/index.js");
    const proc = spawn("node", [cliPath, ...args], {
      env: { ...process.env, ...baseEnv },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    const exitCode = () =>
      new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
    return { proc, stdout: () => stdout, stderr: () => stderr, exitCode };
  }

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-686i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-686i-ws-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(sessionsDir(), { recursive: true, force: true });
    store = new SessionStore(sessionsDir());
    sessionId = store.newId();
    store.checkpoint(
      sessionId,
      [{ role: "user", content: "jsonl fodder" }],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
  });

  it("emits one parseable JSON object per entry, matching the snapshot count", async () => {
    const record = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--output", "json"],
      baseEnv,
    );
    expect(record.code).toBe(0);
    const expected = JSON.parse(record.stdout).entries.length;
    expect(expected).toBeGreaterThan(0);

    const follow = spawnFollow([
      "--workspace-journal", "--workspace", wsDir, "--follow", "--output", "jsonl", "--poll-ms", "100",
    ]);
    await waitFor(() => lines(follow.stdout()).length >= expected);
    const initial = lines(follow.stdout()).slice(0, expected);
    for (const line of initial) {
      const parsed = JSON.parse(line);
      expect(parsed.schema).toBe(WORKSPACE_JOURNAL_SCHEMA);
      expect(parsed.v).toBe(WORKSPACE_JOURNAL_VERSION);
      expect(typeof parsed.at).toBe("number");
      expect(typeof parsed.kind).toBe("string");
      expect(typeof parsed.detail).toBe("string");
      expect(typeof parsed.sessionId).toBe("string");
      expect(typeof parsed.shortId).toBe("string");
    }
    // Let the follow loop settle on a slow runner before signaling, and
    // surface any child error before asserting the clean stop.
    await new Promise((r) => setTimeout(r, 400));
    expect(follow.stderr()).toBe("");
    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("emits exactly one new JSON line for a live append and exits 0 on SIGTERM", async () => {
    const follow = spawnFollow([
      "--workspace-journal", "--workspace", wsDir, "--follow", "--output", "jsonl", "--poll-ms", "100",
    ]);
    await waitFor(() => lines(follow.stdout()).length > 0);
    await new Promise((r) => setTimeout(r, 300));
    const beforeCount = lines(follow.stdout()).length;

    store.writePinned(sessionId, Date.now());
    await waitFor(() => lines(follow.stdout()).length > beforeCount);
    await new Promise((r) => setTimeout(r, 300));
    const after = lines(follow.stdout());
    expect(after.length).toBe(beforeCount + 1);
    const fresh = JSON.parse(after[after.length - 1]);
    expect(fresh.kind).toBe("pinned");

    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("exits 2 for --output jsonl without --follow, before any output", async () => {
    const res = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--output", "jsonl"],
      baseEnv,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--output jsonl requires --follow");
    expect(res.stdout).toBe("");
  });

  it("keeps --output json with --follow exiting 2", async () => {
    const res = await runCli(
      ["--workspace-journal", "--workspace", wsDir, "--follow", "--output", "json"],
      baseEnv,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--follow requires text or jsonl output");
    expect(res.stdout).toBe("");
  });

  it("exits 0 on SIGINT and keeps the store byte-identical", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const follow = spawnFollow([
      "--workspace-journal", "--workspace", wsDir, "--follow", "--output", "jsonl", "--poll-ms", "100",
    ]);
    await waitFor(() => lines(follow.stdout()).length > 0);
    await new Promise((r) => setTimeout(r, 300));
    follow.proc.kill("SIGINT");
    expect(await follow.exitCode()).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });
});
