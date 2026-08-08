import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

describe("Integration: --list-sessions lock state (Issue #793)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let sessionDir: string;
  let baseEnv: Record<string, string>;
  let sleeper: ChildProcess | null = null;

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-locklist-"));
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-my-cli-locklist-sess-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: sessionDir,
    };
  });

  afterAll(async () => {
    if (sleeper && !sleeper.killed) sleeper.kill("SIGKILL");
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  const sessionsDir = () => path.join(sessionDir, ".oh-my-cli", "sessions");
  const lockPathFor = (id: string) => path.join(sessionsDir(), `${id}.lock`);
  const writeLock = (id: string, pid: number) =>
    fs.writeFileSync(lockPathFor(id), JSON.stringify({ pid, lockedAt: Date.now() }, null, 2));

  it("reports lock state in JSON and text, read-only, with live/stale distinction", async () => {
    // Seed a real session through the real CLI.
    server.setResponses([{ type: "text", content: "done" }]);
    const seeded = await runCli(["-p", "Say done", "--workspace", tmpDir], baseEnv);
    expect(seeded.code).toBe(0);

    const listing = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    expect(listing.code).toBe(0);
    const sessions = (JSON.parse(listing.stdout).sessions as Array<{ id: string }>);
    expect(sessions.length).toBeGreaterThan(0);
    const id = sessions[0].id;
    expect(sessions[0].locked).toBe(false);

    // Live holder: lock the session with a real alive pid.
    sleeper = spawn("sleep", ["30"]);
    writeLock(id, sleeper.pid as number);
    const before = fs.readFileSync(lockPathFor(id), "utf8");

    const liveJson = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    expect(liveJson.code).toBe(0);
    const liveEntry = (JSON.parse(liveJson.stdout).sessions as Array<Record<string, unknown>>)
      .find((s) => s.id === id) as Record<string, unknown>;
    expect(liveEntry.locked).toBe(true);
    expect(liveEntry.lockPid).toBe(sleeper.pid);
    expect(liveEntry.lockStale).toBe(false);

    const liveText = await runCli(["--list-sessions", "--workspace", tmpDir], baseEnv);
    expect(liveText.code).toBe(0);
    expect(liveText.stdout).toContain(`(locked by pid ${sleeper.pid})`);
    expect(liveText.stdout).not.toContain("stale");

    // Stale holder: kill the holder, keep the sidecar.
    sleeper.kill("SIGKILL");
    const deadPid = sleeper.pid as number;
    sleeper = null;

    const staleJson = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    expect(staleJson.code).toBe(0);
    const staleEntry = (JSON.parse(staleJson.stdout).sessions as Array<Record<string, unknown>>)
      .find((s) => s.id === id) as Record<string, unknown>;
    expect(staleEntry.locked).toBe(true);
    expect(staleEntry.lockPid).toBe(deadPid);
    expect(staleEntry.lockStale).toBe(true);

    const staleText = await runCli(["--list-sessions", "--workspace", tmpDir], baseEnv);
    expect(staleText.stdout).toContain(`(locked by pid ${deadPid} — stale)`);

    // Read-only proof: the sidecar survived all those listings byte-for-byte,
    // and listing created no new lock files.
    expect(fs.readFileSync(lockPathFor(id), "utf8")).toBe(before);
    const lockFiles = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".lock"));
    expect(lockFiles).toEqual([`${id}.lock`]);

    // Unlock (manual removal is the documented override) → unlocked again.
    fs.rmSync(lockPathFor(id));
    const cleared = await runCli(["--list-sessions", "--output", "json", "--workspace", tmpDir], baseEnv);
    const clearedEntry = (JSON.parse(cleared.stdout).sessions as Array<Record<string, unknown>>)
      .find((s) => s.id === id) as Record<string, unknown>;
    expect(clearedEntry.locked).toBe(false);
    expect(clearedEntry.lockPid).toBeUndefined();
  });
});
