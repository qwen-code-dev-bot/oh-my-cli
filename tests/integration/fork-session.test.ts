import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeServer } from "../fake-provider.js";
import type { FakeServer } from "../fake-provider.js";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";
import { runGoalCommand } from "../../src/session-goal.js";

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

describe("Integration: session fork (--fork-session, Issue #592)", () => {
  let server: FakeServer;
  let tmpDir: string;
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;
  const NOW = 1_786_000_000_000;

  function sessionsDir(): string {
    return path.join(homeDir, ".oh-my-cli", "sessions");
  }

  function sessionFileCount(): number {
    return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl")).length;
  }

  beforeAll(async () => {
    server = await createFakeServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-592i-ws-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-592i-home-"));
    baseEnv = {
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: server.url,
      OPENAI_MODEL: "fake-model",
      HOME: homeDir,
    };
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.requests.length = 0;
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seedSource(opts: { goal?: boolean } = {}): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: tmpDir, createdAt: NOW });
    store.append(id, { role: "user", content: "seed question" });
    store.append(id, { role: "assistant", content: "seed answer" });
    if (opts.goal) {
      runGoalCommand(store, id, "continue the migration", NOW + 1);
      runGoalCommand(store, id, "title Migration", NOW + 2);
    }
    return id;
  }

  it("forks a healthy session by id, copies the goal, and leaves the source byte-identical", async () => {
    const id = seedSource({ goal: true });
    const transcriptBefore = fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8");
    const goalBefore = fs.readFileSync(store.goalPath(id), "utf-8");

    const r = await runCli(["--fork-session", id], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Forked session");
    expect(r.stdout).toContain("(2 message(s), goal copied)");
    const newId = /into new session (\S+)/.exec(r.stdout)?.[1];
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(id);

    // Source byte-identity: transcript and goal sidecar untouched.
    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(transcriptBefore);
    expect(fs.readFileSync(store.goalPath(id), "utf-8")).toBe(goalBefore);

    // The fork carries the copied goal.
    const goal = await runCli(["--goal-status", newId!, "--output", "json"], baseEnv);
    expect(goal.code).toBe(0);
    const parsed = JSON.parse(goal.stdout.trim());
    expect(parsed.goal.title).toBe("Migration");
    expect(parsed.goal.objective).toBe("continue the migration");
    expect(parsed.goal.revision).toBe(1);
  });

  it("emits a versioned JSON record with provenance", async () => {
    const id = seedSource({ goal: true });
    const r = await runCli(["--fork-session", id, "--output", "json"], baseEnv);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.schema).toBe("oh-my-cli.session-fork");
    expect(record.v).toBe(1);
    expect(record.sourceSessionId).toBe(id);
    expect(typeof record.newSessionId).toBe("string");
    expect(record.newSessionId).not.toBe(id);
    expect(record.forkedMessages).toBe(2);
    expect(record.forkedGoal).toBe(true);
    expect(record.name).toBeNull();

    // The fork's meta records the forkedFrom provenance.
    const meta = store.readMeta(record.newSessionId);
    expect(meta?.forkedFrom).toBe(id);
    expect(meta?.workspace).toBe(tmpDir);
    expect(meta?.createdAt).not.toBe(NOW);
  });

  it("forks by user-owned name and names the fork with --session-name", async () => {
    const id = seedSource();
    store.writeName(id, "original work");

    const r = await runCli(
      ["--fork-session", "original work", "--session-name", "fork experiment", "--output", "json"],
      baseEnv,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    const record = JSON.parse(r.stdout.trim());
    expect(record.sourceSessionId).toBe(id);
    expect(record.name).toBe("fork experiment");

    // The fork is addressable by its new name on a session-targeted surface.
    const status = await runCli(["--goal-status", "fork experiment"], baseEnv);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("No goal recorded");
    // The source keeps its own name.
    expect(store.readName(id)).toBe("original work");
  });

  it("fails closed on an invalid fork name without creating anything", async () => {
    const id = seedSource();
    const before = sessionFileCount();
    const r = await runCli(
      ["--fork-session", id, "--session-name", "bad\u001bname"],
      baseEnv,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cannot fork");
    expect(r.stderr).toContain("control characters");
    expect(sessionFileCount()).toBe(before);
  });

  it("refuses a corrupt source fail-closed with nothing created", async () => {
    const id = "corrupt-592";
    // Damage mid-file (a trailing torn line would be "partial", not corrupt).
    fs.writeFileSync(
      path.join(sessionsDir(), `${id}.jsonl`),
      `${JSON.stringify({ role: "user", content: "kept" })}\n{broken mid-file\n${JSON.stringify({ role: "assistant", content: "after" })}\n`,
    );
    const before = sessionFileCount();
    const corruptBefore = fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8");
    const r = await runCli(["--fork-session", id], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("corrupt");
    expect(r.stderr).toContain("--salvage-session");
    expect(sessionFileCount()).toBe(before);
    // No heal side effects: the corrupt source is untouched, not quarantined.
    expect(fs.readFileSync(path.join(sessionsDir(), `${id}.jsonl`), "utf-8")).toBe(corruptBefore);
    expect(fs.readdirSync(sessionsDir()).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("fails closed for an unknown session value", async () => {
    const r = await runCli(["--fork-session", "no-such-session"], baseEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cannot fork");
  });

  it("forks a goal-less session and reports it truthfully", async () => {
    const id = seedSource();
    const r = await runCli(["--fork-session", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(2 message(s), no goal)");
    const newId = /into new session (\S+)/.exec(r.stdout)?.[1];
    expect(fs.existsSync(store.goalPath(newId!))).toBe(false);
  });

  it("resumes the fork end-to-end with the copied transcript", async () => {
    const id = seedSource({ goal: true });
    const fork = await runCli(["--fork-session", id, "--output", "json"], baseEnv);
    expect(fork.code).toBe(0);
    const newId = (JSON.parse(fork.stdout.trim()) as { newSessionId: string }).newSessionId;

    server.setResponses([{ type: "text", content: "resumed fork answer" }]);
    const resumed = await runCli(
      ["-p", "continue", "--resume", newId, "--approval-mode", "yolo", "--workspace", tmpDir],
      baseEnv,
    );
    expect(resumed.code, `stderr: ${resumed.stderr}`).toBe(0);
    expect(resumed.stdout).toContain("resumed fork answer");
    // The resume summary surfaces the forked goal title-first.
    expect(resumed.stderr).toContain("Goal: active (Migration)");
    // The provider received the copied history plus the new prompt.
    const last = server.requests[server.requests.length - 1]!.body as {
      messages: Array<{ role: string; content?: string }>;
    };
    const contents = last.messages.map((m) => m.content ?? "");
    expect(contents).toContain("seed question");
    expect(contents).toContain("seed answer");
    expect(contents).toContain("continue");
  });
});
