import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { SessionStore } from "../../src/session.js";

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

describe("Integration: headless Goal inspection (--goal-status, Issue #578)", () => {
  let homeDir: string;
  let baseEnv: Record<string, string>;
  let store: SessionStore;

  beforeAll(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-578i-"));
    baseEnv = { HOME: homeDir };
  });

  afterAll(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(homeDir, ".oh-my-cli"), { recursive: true, force: true });
    // SessionStore's baseDir is the sessions directory itself; the CLI process
    // resolves the same path from HOME.
    store = new SessionStore(path.join(homeDir, ".oh-my-cli", "sessions"));
  });

  function seedSession(): string {
    const id = store.newId();
    store.writeMeta(id, { model: "fake-model", workspace: "/tmp/ws", createdAt: 1 });
    store.append(id, { role: "user", content: "hi" });
    return id;
  }

  function goalPath(id: string): string {
    return path.join(homeDir, ".oh-my-cli", "sessions", `${id}.goal.json`);
  }

  it("renders an active goal from the durable checkpoint (text and json)", async () => {
    const id = seedSession();
    store.writeGoal(id, {
      revision: 2,
      goal: { objective: "land the feature", status: "active", createdAt: 1785200000000, updatedAt: 1785200005000 },
    });

    const text = await runCli(["--goal-status", id], baseEnv);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Goal status");
    expect(text.stdout).toContain("status:    active");
    expect(text.stdout).toContain("objective: land the feature");
    expect(text.stdout).toContain("revision:  2");
    expect(text.stdout).not.toMatch(/\x1b\[/);

    const json = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout.trim());
    expect(parsed.schema).toBe("oh-my-cli.goal-status");
    expect(parsed.v).toBe(1);
    expect(parsed.sessionId).toBe(id);
    expect(parsed.hasGoal).toBe(true);
    expect(parsed.goal.status).toBe("active");
    expect(parsed.goal.objective).toBe("land the feature");
    expect(parsed.goal.revision).toBe(2);
    expect(parsed.goal.createdAt).toBe(new Date(1785200000000).toISOString());
  });

  it("renders the explicit no-goal state with exit 0", async () => {
    const id = seedSession();
    const r = await runCli(["--goal-status", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No goal recorded for this session.");
  });

  it("renders the honest no-goal state for a corrupt sidecar and preserves the bytes", async () => {
    const id = seedSession();
    fs.writeFileSync(goalPath(id), "{ not json");
    const r = await runCli(["--goal-status", id], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No goal recorded for this session.");
    expect(fs.readFileSync(goalPath(id), "utf8")).toBe("{ not json");
  });

  it("is strictly read-only: goal sidecar and session are byte-identical after reads", async () => {
    const id = seedSession();
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "keep me intact", status: "paused", createdAt: 1785200000000, updatedAt: 1785200000000 },
    });
    const before = fs.readFileSync(goalPath(id), "utf8") + fs.readFileSync(store.filePath(id), "utf8");
    const a = await runCli(["--goal-status", id], baseEnv);
    const b = await runCli(["--goal-status", id, "--output", "json"], baseEnv);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const after = fs.readFileSync(goalPath(id), "utf8") + fs.readFileSync(store.filePath(id), "utf8");
    expect(after).toBe(before);
  });

  it("fails closed (exit 2) for an unknown session and a bad format", async () => {
    const missing = await runCli(["--goal-status", "no-such-session"], baseEnv);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Error");

    const id = seedSession();
    const bad = await runCli(["--goal-status", id, "--output", "yaml"], baseEnv);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid output format");
  });

  it("resolves by user-owned name like the sibling surfaces", async () => {
    const id = seedSession();
    store.writeName(id, "goalful");
    store.writeGoal(id, {
      revision: 1,
      goal: { objective: "named session goal", status: "achieved", createdAt: 1785200000000, updatedAt: 1785200000000 },
    });
    const r = await runCli(["--goal-status", "goalful"], baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status:    achieved");
    expect(r.stdout).toContain("objective: named session goal");
  });
});
