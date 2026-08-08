import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { SESSION_JOURNAL_SCHEMA, SESSION_JOURNAL_VERSION } from "../../src/session-journal.js";

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
    if (Date.now() > deadline) throw new Error("timed out waiting for follow output");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function lines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.length > 0);
}

describe("Integration: session journal follow (--follow, Issue #688)", () => {
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
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-688i-home-"));
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-688i-ws-"));
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
      [{ role: "user", content: "follow fodder" }],
      { model: "fake-model", workspace: wsDir, createdAt: CREATED_AT },
    );
  });

  it("prints an initial snapshot byte-identical to the non-follow surface", async () => {
    const snapshot = await runCli(["--session-journal", sessionId], baseEnv);
    expect(snapshot.code).toBe(0);

    const follow = spawnFollow(["--session-journal", sessionId, "--follow", "--poll-ms", "100"]);
    await waitFor(() => follow.stdout().length >= snapshot.stdout.length);
    expect(follow.stdout().slice(0, snapshot.stdout.length)).toBe(snapshot.stdout);

    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("emits newly appended entries live and exits 0 on SIGTERM", async () => {
    const follow = spawnFollow(["--session-journal", sessionId, "--follow", "--poll-ms", "100"]);
    await waitFor(() => follow.stdout().includes("Session journal —"));
    const before = follow.stdout();
    expect(before).not.toContain("pinned to the top of discovery");

    store.writePinned(sessionId, Date.now());
    await waitFor(() => follow.stdout().includes("pinned to the top of discovery"));
    const emitted = follow.stdout().slice(before.length);
    expect(emitted).toContain("pinned");

    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("streams --output jsonl: parseable lines and one new line per live append", async () => {
    const follow = spawnFollow([
      "--session-journal", sessionId, "--follow", "--output", "jsonl", "--poll-ms", "100",
    ]);
    await waitFor(() => lines(follow.stdout()).length > 0);
    await new Promise((r) => setTimeout(r, 300));
    const initial = lines(follow.stdout());
    for (const line of initial) {
      const parsed = JSON.parse(line);
      expect(parsed.schema).toBe(SESSION_JOURNAL_SCHEMA);
      expect(parsed.v).toBe(SESSION_JOURNAL_VERSION);
      expect(parsed.sessionId).toBe(sessionId);
      expect(typeof parsed.at).toBe("number");
      expect(typeof parsed.kind).toBe("string");
      expect(typeof parsed.detail).toBe("string");
    }

    store.writePinned(sessionId, Date.now());
    await waitFor(() => lines(follow.stdout()).length > initial.length);
    await new Promise((r) => setTimeout(r, 300));
    const after = lines(follow.stdout());
    expect(after.length).toBe(initial.length + 1);
    expect(JSON.parse(after[after.length - 1]).kind).toBe("pinned");

    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("keeps --kind live while following", async () => {
    const follow = spawnFollow([
      "--session-journal", sessionId, "--follow", "--poll-ms", "100", "--kind", "goal",
    ]);
    await waitFor(() => follow.stdout().includes("Session journal —"));

    store.writePinned(sessionId, Date.now());
    await new Promise((r) => setTimeout(r, 600));
    expect(follow.stdout()).not.toContain("pinned to the top of discovery");

    store.writeGoal(sessionId, {
      revision: 1,
      goal: { objective: "mission", status: "active", createdAt: Date.now(), updatedAt: Date.now() },
      history: [{ revision: 1, kind: "set", objective: "mission", status: "active", at: Date.now() }],
    });
    await waitFor(() => follow.stdout().includes("· goal ·"));

    follow.proc.kill("SIGTERM");
    expect(await follow.exitCode()).toBe(0);
  });

  it("exits 2 with --output json before any output", async () => {
    const res = await runCli(
      ["--session-journal", sessionId, "--follow", "--output", "json"],
      baseEnv,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--follow requires text or jsonl output");
    expect(res.stdout).toBe("");
  });

  it("exits 2 when combined with the aggregation surfaces", async () => {
    const res = await runCli(["--session-journal", sessionId, "--follow", "--count"], baseEnv);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--follow cannot be combined with");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on a bad --poll-ms before any output", async () => {
    const res = await runCli(
      ["--session-journal", sessionId, "--follow", "--poll-ms", "10"],
      baseEnv,
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("invalid --poll-ms value");
    expect(res.stdout).toBe("");
  });

  it("exits 0 on SIGINT and keeps the store byte-identical", async () => {
    const snapshot = new Map<string, string>();
    for (const f of fs.readdirSync(sessionsDir())) {
      snapshot.set(f, fs.readFileSync(path.join(sessionsDir(), f), "utf-8"));
    }
    const follow = spawnFollow(["--session-journal", sessionId, "--follow", "--poll-ms", "100"]);
    await waitFor(() => follow.stdout().includes("Session journal —"));
    await new Promise((r) => setTimeout(r, 300));
    follow.proc.kill("SIGINT");
    expect(await follow.exitCode()).toBe(0);
    for (const [f, content] of snapshot) {
      expect(fs.readFileSync(path.join(sessionsDir(), f), "utf-8")).toBe(content);
    }
  });

  it("exits 0 on SIGTERM across repeated cycles — the timing window stays covered (Issue #795)", async () => {
    // The CI flake was load-dependent: the follow process died by signal
    // instead of its clean-exit handler. Repeating the spawn -> snapshot ->
    // SIGTERM cycle keeps the timing window covered on every run. The
    // assertion stays strict: clean exit is 0, never signal death.
    const CYCLES = 10;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const follow = spawnFollow(["--session-journal", sessionId, "--follow", "--poll-ms", "100"]);
      await waitFor(() => follow.stdout().includes("Session journal —"));
      follow.proc.kill("SIGTERM");
      const code = await follow.exitCode();
      expect(code, `cycle ${cycle} exited ${code}`).toBe(0);
    }
  }, 120_000);
});
